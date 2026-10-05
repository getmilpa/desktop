// A security key that is a process: a CTAP2 authenticator WITH A PIN, speaking CTAPHID over a socket — for the tests
// and the lab, so that nothing they do opens a person's real key (MILPA_SECURITY_KEYS names its socket).
//
// WHY IT EXISTS. DevTools' virtual authenticator has no PIN: `hasUserVerification` models a key that verifies its
// user by itself, or one that never can — not one that asks its client for a PIN. This one keeps a PIN, counts the
// attempts like a key does (eight; three wrong in a row and it wants to be unplugged), and writes down every command
// it is sent — which is how a test knows that a wrong PIN went to the key once, and only once.
//
// It is the key's side written from the standard (FIDO CTAP 2.1 §6), and it is checked against Yubico's client
// (test/virtual-key-check.py), so the Desktop's client is not measured against a key that merely shares its bugs.
//
// (c) Rodrigo Vicente - TeamX Agency — Apache-2.0
'use strict'
const net = require('node:net')
const fs = require('node:fs')
const crypto = require('node:crypto')
const cbor = require('../security-key/cbor.js')
const { PROTOCOLS } = require('../security-key/pin.js')

const S = { OK: 0, INVALID_COMMAND: 0x01, MISSING_PARAMETER: 0x14, CREDENTIAL_EXCLUDED: 0x19, UNSUPPORTED_ALGORITHM: 0x26, KEEPALIVE_CANCEL: 0x2d, NO_CREDENTIALS: 0x2e, PIN_INVALID: 0x31, PIN_BLOCKED: 0x32, PIN_AUTH_INVALID: 0x33, PIN_AUTH_BLOCKED: 0x34, PIN_NOT_SET: 0x35, PUAT_REQUIRED: 0x36 }
const NAMES = { 0x01: 'makeCredential', 0x02: 'getAssertion', 0x04: 'getInfo', 0x06: 'clientPin', 0x0b: 'selection' }
const SUBS = { 1: 'retries', 2: 'keyAgreement', 5: 'pinToken', 9: 'pinTokenWithPermissions' }
const sha256 = (b) => crypto.createHash('sha256').update(b).digest()
const cose = (pub) => new Map([[1, 2], [3, -7], [-1, 1], [-2, pub.subarray(1, 33)], [-3, pub.subarray(33, 65)]])

function virtualKey ({ pin = '1234', protocols = [2, 1], versions = ['FIDO_2_0', 'FIDO_2_1'], uv, scopedToken = true, maxCredentialsInList, touch = 'auto', attempts = 8, cbor: speaksCbor = true, omitsCredential = false, forgetsVerification = false } = {}) {
  const key = { log: [], credentials: new Map(), retries: attempts, waiting: false, touches: 0 }
  let pinHash = pin == null ? null : sha256(Buffer.from(pin.normalize('NFC'), 'utf8')).subarray(0, 16)
  let wrongInARow = 0; let agreement = crypto.createECDH('prime256v1'); agreement.generateKeys()
  let token = null   // { bytes, version, permissions, rpId }
  let pendingTouch = null

  key.setPin = (p) => { pinHash = p == null ? null : sha256(Buffer.from(p, 'utf8')).subarray(0, 16) }
  key.replug = () => { wrongInARow = 0; token = null }
  key.touch = () => { if (pendingTouch) { const t = pendingTouch; pendingTouch = null; key.waiting = false; key.touches++; t.resolve(true) } }
  const waitTouch = (conn) => new Promise((resolve) => {
    key.waiting = true
    pendingTouch = { resolve }
    conn.cancel = () => { if (pendingTouch) { pendingTouch = null; key.waiting = false; resolve(false) } }
    if (touch === 'auto') setTimeout(() => key.touch(), 60)
  })

  function clientPin (p) {
    const proto = PROTOCOLS[p.get(1)]; const sub = p.get(2)
    if (!proto || !protocols.includes(proto.version)) return [0x02]
    if (sub === 1) return [S.OK, new Map([[3, key.retries]])]
    if (sub === 2) return [S.OK, new Map([[1, new Map([[1, 2], [3, -25], [-1, 1], [-2, agreement.getPublicKey().subarray(1, 33)], [-3, agreement.getPublicKey().subarray(33, 65)]])]])]
    if (sub === 5 || sub === 9) {
      if (sub === 9 && (!scopedToken || !p.get(9))) return [sub === 9 && !scopedToken ? S.INVALID_COMMAND : S.MISSING_PARAMETER]
      if (pinHash === null) return [S.PIN_NOT_SET]
      if (key.retries === 0) return [S.PIN_BLOCKED]
      if (wrongInARow >= 3) return [S.PIN_AUTH_BLOCKED]
      const peer = p.get(3)
      const z = agreement.computeSecret(Buffer.concat([Buffer.from([4]), peer.get(-2), peer.get(-3)]))
      const secret = proto.kdf(z)
      key.retries--
      let sent = null
      try { sent = proto.decrypt(secret, p.get(6)) } catch {}
      if (!sent || sent.length !== 16 || !crypto.timingSafeEqual(sent, pinHash)) {
        agreement = crypto.createECDH('prime256v1'); agreement.generateKeys()
        if (key.retries === 0) return [S.PIN_BLOCKED]
        if (++wrongInARow >= 3) return [S.PIN_AUTH_BLOCKED]
        return [S.PIN_INVALID]
      }
      key.retries = attempts; wrongInARow = 0
      token = { bytes: crypto.randomBytes(32), version: proto.version, permissions: sub === 9 ? p.get(9) : null, rpId: sub === 9 ? p.get(10) : null }
      return [S.OK, new Map([[2, proto.encrypt(secret, token.bytes)]])]
    }
    return [S.INVALID_COMMAND]
  }

  // Whether the proof was made with the token this key last handed out — and, for a scoped token, for this act.
  function proven (proof, version, clientDataHash, permission, rpId) {
    const proto = PROTOCOLS[version]
    if (!token || !proto || token.version !== version) return false
    if (token.permissions !== null && (!(token.permissions & permission) || (token.rpId && token.rpId !== rpId))) return false
    const expected = proto.authenticate(token.bytes, clientDataHash)
    return expected.length === proof.length && crypto.timingSafeEqual(expected, proof)
  }

  async function makeCredential (p, conn) {
    const proof = p.get(8)
    if (proof && proof.length === 0) { if (!await waitTouch(conn)) return [S.KEEPALIVE_CANCEL]; return [pinHash === null ? S.PIN_NOT_SET : S.PIN_INVALID] }
    if (!(p.get(4) || []).some(a => a.get('alg') === -7 && a.get('type') === 'public-key')) return [S.UNSUPPORTED_ALGORITHM]
    const rp = p.get(2); const rpId = rp.get('id')
    let verified = false
    if (pinHash !== null) {
      if (!proof) return [S.PUAT_REQUIRED]
      if (!proven(proof, p.get(9), p.get(1), 1, rpId)) return [S.PIN_AUTH_INVALID]
      verified = true
    }
    const excluded = (p.get(5) || []).some(d => { const c = key.credentials.get(d.get('id').toString('hex')); return c && c.rpId === rpId })
    if (!await waitTouch(conn)) return [S.KEEPALIVE_CANCEL]
    if (excluded) return [S.CREDENTIAL_EXCLUDED]
    const pair = crypto.generateKeyPairSync('ec', { namedCurve: 'prime256v1' })
    const jwk = pair.publicKey.export({ format: 'jwk' })
    const pub = Buffer.concat([Buffer.from([4]), Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')])
    const id = crypto.randomBytes(32)
    key.credentials.set(id.toString('hex'), { rpId, privateKey: pair.privateKey, userId: p.get(3).get('id'), counter: 0 })
    const length = Buffer.alloc(2); length.writeUInt16BE(id.length)
    const authData = Buffer.concat([sha256(Buffer.from(rpId)), Buffer.from([0x01 | (verified && !forgetsVerification ? 0x04 : 0) | 0x40]), Buffer.alloc(4), Buffer.from('6d696c70612d6c61622d6b65792d3031', 'hex'), length, id, cbor.encode(cose(pub))])
    const sig = crypto.sign('sha256', Buffer.concat([authData, p.get(1)]), pair.privateKey)
    token = null   // a token serves one ceremony
    return [S.OK, new Map([[1, 'packed'], [2, authData], [3, new Map([['alg', -7], ['sig', sig]])]])]
  }

  async function getAssertion (p, conn) {
    const rpId = p.get(1); const allow = p.get(3) || []
    let id = null; let cred = null
    for (const d of allow) { const c = key.credentials.get(d.get('id').toString('hex')); if (c && c.rpId === rpId) { id = d.get('id'); cred = c; break } }
    const proof = p.get(6)
    let verified = false
    if (proof) { if (!proven(proof, p.get(7), p.get(2), 2, rpId)) return [S.PIN_AUTH_INVALID]; verified = true }
    const present = !(p.get(5) instanceof Map && p.get(5).get('up') === false)
    if (present && !await waitTouch(conn)) return [S.KEEPALIVE_CANCEL]
    if (!cred) return [S.NO_CREDENTIALS]
    const counter = Buffer.alloc(4); counter.writeUInt32BE(++cred.counter)
    const authData = Buffer.concat([sha256(Buffer.from(rpId)), Buffer.from([(present ? 0x01 : 0) | (verified && !forgetsVerification ? 0x04 : 0)]), counter])
    const signature = crypto.sign('sha256', Buffer.concat([authData, p.get(2)]), cred.privateKey)
    if (verified) token = null
    const answer = new Map([[2, authData], [3, signature]])
    // The standard lets a key leave the credential out when it was asked about exactly one; some do.
    if (!(omitsCredential && allow.length === 1)) answer.set(1, new Map([['id', id], ['type', 'public-key']]))
    return [S.OK, answer]
  }

  async function command (body, conn) {
    const code = body[0]
    const p = body.length > 1 ? cbor.decode(body.subarray(1)) : new Map()
    const entry = { command: NAMES[code] || '0x' + code.toString(16) }
    if (code === 0x06) entry.sub = SUBS[p.get(2)] || p.get(2)
    if (code === 0x01) { entry.rpId = p.get(2).get('id'); entry.probe = !!(p.get(8) && p.get(8).length === 0); entry.proof = !!(p.get(8) && p.get(8).length) }
    if (code === 0x02) { entry.rpId = p.get(1); entry.allow = (p.get(3) || []).length; entry.proof = !!p.get(6); entry.silent = p.get(5) instanceof Map && p.get(5).get('up') === false }
    key.log.push(entry)
    let answer
    if (code === 0x04) {
      const options = { rk: false, up: true, clientPin: pinHash !== null }
      if (uv !== undefined) options.uv = uv
      if (scopedToken) options.pinUvAuthToken = true
      const m = new Map([[1, versions], [3, Buffer.from('6d696c70612d6c61622d6b65792d3031', 'hex')], [4, options], [6, protocols]])
      if (maxCredentialsInList) m.set(7, maxCredentialsInList)
      answer = [S.OK, m]
    } else if (code === 0x06) answer = clientPin(p)
    else if (code === 0x01) answer = await makeCredential(p, conn)
    else if (code === 0x02) answer = await getAssertion(p, conn)
    else if (code === 0x0b && versions.includes('FIDO_2_1')) answer = [await waitTouch(conn) ? S.OK : S.KEEPALIVE_CANCEL]
    else answer = [S.INVALID_COMMAND]
    entry.status = answer[0]
    return answer.length > 1 ? Buffer.concat([Buffer.from([answer[0]]), cbor.encode(answer[1])]) : Buffer.from([answer[0]])
  }

  // ── CTAPHID, the key's side ──
  const frame = (cid, cmd, payload) => {
    const out = []; const first = Buffer.alloc(64)
    first.writeUInt32BE(cid, 0); first[4] = 0x80 | cmd; first.writeUInt16BE(payload.length, 5); payload.copy(first, 7, 0, 57); out.push(first)
    let seq = 0
    for (let at = 57; at < payload.length; at += 59) { const n = Buffer.alloc(64); n.writeUInt32BE(cid, 0); n[4] = seq++; payload.copy(n, 5, at, at + 59); out.push(n) }
    return Buffer.concat(out)
  }
  let nextCid = 0x0a0b0c00
  const server = net.createServer((sock) => {
    const conn = { cancel: null }
    let pending = Buffer.alloc(0); let message = null; let busy = false
    sock.on('error', () => {})
    // A key whose client went away without a word keeps waiting for its touch — only CANCEL makes it stop.
    sock.on('data', async (d) => {
      pending = Buffer.concat([pending, d])
      while (pending.length >= 64) {
        const r = pending.subarray(0, 64); pending = pending.subarray(64)
        const cid = r.readUInt32BE(0)
        if (r[4] & 0x80) message = { cid, cmd: r[4] & 0x7f, length: r.readUInt16BE(5), data: Buffer.from(r.subarray(7, 7 + Math.min(r.readUInt16BE(5), 57))) }
        else if (message) message.data = Buffer.concat([message.data, r.subarray(5, 5 + Math.min(message.length - message.data.length, 59))])
        if (!message || message.data.length < message.length) continue
        const m = message; message = null
        if (m.cmd === 0x06) {   // INIT
          const cidOut = ++nextCid; const body = Buffer.alloc(17); m.data.copy(body, 0, 0, 8); body.writeUInt32BE(cidOut, 8); body[12] = 2; body[16] = speaksCbor ? 0x04 : 0
          sock.write(frame(m.cid, 0x06, body))
        } else if (m.cmd === 0x11) { if (conn.cancel) conn.cancel() } else if (m.cmd === 0x10) {
          if (busy) { sock.write(frame(m.cid, 0x3f, Buffer.from([0x06]))); continue }
          busy = true
          const alive = setInterval(() => { if (key.waiting) sock.write(frame(m.cid, 0x3b, Buffer.from([2]))) }, 25)
          let answer
          try { answer = await command(m.data, conn) } catch (e) { key.log.push({ command: 'crashed', error: String(e) }); answer = Buffer.from([0x7f]) }
          clearInterval(alive); busy = false; conn.cancel = null
          if (!sock.destroyed) sock.write(frame(m.cid, 0x10, answer))
        } else sock.write(frame(m.cid, 0x3f, Buffer.from([0x01])))
      }
    })
  })
  key.listen = (file) => new Promise((resolve, reject) => { try { fs.unlinkSync(file) } catch {} server.once('error', reject); server.listen(file, () => { key.path = file; resolve(key) }) })
  key.close = () => new Promise((resolve) => { server.close(() => resolve()); try { fs.unlinkSync(key.path) } catch {} })
  /** What the key was sent, as words: `clientPin:pinToken`, `makeCredential`, … */
  key.said = () => key.log.map(e => e.command + (e.sub ? ':' + e.sub : '') + (e.probe ? ':probe' : '') + (e.silent ? ':silent' : ''))
  return key
}

module.exports = { virtualKey }

// Run as a program, it is a key on a socket until it is killed: `node test/virtual-key.js <socket> [pin]`. It prints
// one line of JSON for every command it is sent — never the PIN, which it does not receive.
if (require.main === module) {
  const [file, pin] = process.argv.slice(2)
  if (!file) { console.error('usage: node test/virtual-key.js <socket> [pin|none]'); process.exit(2) }
  const key = virtualKey({ pin: pin === 'none' ? null : (pin || '1234'), touch: process.env.VIRTUAL_KEY_TOUCH || 'auto', versions: (process.env.VIRTUAL_KEY_VERSIONS || 'FIDO_2_0,FIDO_2_1').split(',') })
  key.listen(file).then(() => {
    console.log(JSON.stringify({ listening: file }))
    let seen = 0
    setInterval(() => { for (; seen < key.log.length; seen++) if (key.log[seen].status !== undefined) console.log(JSON.stringify({ ...key.log[seen], retries: key.retries })); else break }, 50)
  })
  process.on('SIGUSR1', () => key.touch())
  process.on('SIGUSR2', () => key.replug())
}
