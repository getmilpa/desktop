// A passkey ceremony with a security key that asks for a PIN, done by the Desktop (greenhouse decisions/0568).
//
// WHY THE DESKTOP DOES IT. The house requires user verification (decisions/0244 §1). A key without a fingerprint
// reader verifies its user by PIN, and the PIN is asked by the CLIENT, not by the key. Chromium has that dialog in
// Chrome; Electron ships without it — through 44, the newest — so in this window the key was never even asked
// (evidence/1100). Here the Desktop is that client: it talks to the key itself and asks for the PIN in a window of
// its own.
//
// WHAT THE PAGE CAN AND CANNOT DO. The page hands in what it would hand `navigator.credentials` — a challenge and
// who it is for — and gets back what `navigator.credentials` returns. It never sees the PIN, never chooses the
// origin (this process writes the origin into what the key signs, from the frame that asked), and cannot name a
// relying party that is not its own host.
//
// THE PIN IS TRIED ONCE PER TIME IT IS TYPED. A key allows eight wrong PINs before it must be reset, three before it
// must be unplugged. Nothing here sends a PIN again by itself: a refused PIN goes back to the person, with the
// attempts the key says are left.
//
// `ui` is the Desktop's own window, handed in: `tell(view)`, `askPin(view)` → the PIN or null, `acknowledge(view)` →
// when the person has read a failure, and `signal`, aborted when they close it. So this file runs without Electron.
//
// (c) Rodrigo Vicente - TeamX Agency — Apache-2.0
'use strict'
const crypto = require('node:crypto')
const cbor = require('./cbor.js')
const hid = require('./hid.js')
const ctap = require('./ctap.js')
const pinProtocol = require('./pin.js')

const sha256 = (b) => crypto.createHash('sha256').update(b).digest()
const b64u = (b) => Buffer.from(b).toString('base64url')
const bytes = (s) => (typeof s === 'string' ? Buffer.from(s, 'base64url') : Buffer.alloc(0))
const S = ctap.STATUS

// What the page is told when a ceremony does not happen — the words a browser uses, and no more than a browser says:
// why, exactly, is the person's to read in the Desktop's window, not the page's.
const WORDS = {
  NotAllowedError: 'The operation either timed out or was not allowed.',
  InvalidStateError: 'The security key is already registered here.',
  NotSupportedError: 'The security key does not support what was asked.',
  SecurityError: 'The relying party ID is not a registrable domain suffix of, nor equal to the current domain.',
  TypeError: 'The request is not one for a public-key credential.',
}
class Refusal extends Error { constructor (name, message) { super(message || WORDS[name]); this.name = name } }
// A ceremony that ends without a credential: `problem` is what the person is shown (null: they closed the window
// themselves and need no telling), `name` what the page is told.
class Stop extends Error { constructor (problem, name = 'NotAllowedError') { super(problem || 'cancelled'); this.problem = problem; this.dom = name } }

/** The request, read: every field checked before any key is spoken to. Throws a Refusal the page is given as is. */
function read (kind, origin, publicKey) {
  const pk = publicKey && typeof publicKey === 'object' ? publicKey : null
  if (!pk || (kind !== 'create' && kind !== 'get')) throw new Refusal('TypeError')
  let host = ''
  try { host = new URL(origin).hostname } catch { throw new Refusal('SecurityError') }
  const rpId = String(kind === 'create' ? ((pk.rp && pk.rp.id) || host) : (pk.rpId || host))
  // A passkey is bound to the name in the address bar: the page may name its own host or a parent of it, nothing else.
  if (!(host === rpId || host.endsWith('.' + rpId)) || rpId === '') throw new Refusal('SecurityError')
  const challenge = bytes(pk.challenge)
  if (challenge.length === 0) throw new Refusal('TypeError')
  const list = (l) => (Array.isArray(l) ? l : []).filter(c => c && c.type === 'public-key' && typeof c.id === 'string').map(c => ({ id: bytes(c.id) })).filter(c => c.id.length > 0)
  const wait = Number(pk.timeout)
  const request = { kind, origin: new URL(origin).origin, rpId, challenge, timeout: Math.min(600000, Math.max(15000, Number.isFinite(wait) && wait > 0 ? wait : 120000)) }
  if (kind === 'create') {
    const user = pk.user || {}; const selection = pk.authenticatorSelection || {}
    const id = bytes(user.id)
    if (id.length < 1 || id.length > 64 || typeof user.name !== 'string') throw new Refusal('TypeError')
    const params = (Array.isArray(pk.pubKeyCredParams) ? pk.pubKeyCredParams : []).filter(p => p && p.type === 'public-key' && Number.isInteger(p.alg)).map(p => ({ type: 'public-key', alg: p.alg }))
    if (params.length === 0) throw new Refusal('NotSupportedError')
    return {
      ...request, params, exclude: list(pk.excludeCredentials),
      rp: { id: rpId, name: String((pk.rp && pk.rp.name) || rpId) },
      user: { id, name: user.name, displayName: String(user.displayName || user.name) },
      userVerification: selection.userVerification || 'preferred',
      residentKey: selection.residentKey === 'required' || selection.requireResidentKey === true,
      attestation: pk.attestation || 'none',
    }
  }
  return { ...request, allow: list(pk.allowCredentials), userVerification: pk.userVerification || 'preferred' }
}

// Every key plugged in that speaks CTAP2, opened and asked what it is. One that does not answer is left out.
async function plugged (discover) {
  const found = []
  for (const k of discover()) {
    let ch = null
    try {
      const transport = k.open()
      try { ch = await hid.channel(transport) } catch (e) { transport.close(); throw e }
      if (!ch.canCbor) { ch.close(); continue }
      found.push({ name: k.name, ch, ...(await ctap.info(ch)) })
    } catch { if (ch) ch.close() }
  }
  return found
}

// Which of these credentials the key holds, asked without a touch and without the PIN — so a key this house does not
// know is told apart before anybody types anything. `undefined`: the key would not say (it wants its PIN first).
async function holds (key, request) {
  const size = key.maxCredentialsInList || request.allow.length
  for (let at = 0; at < request.allow.length; at += size) {
    const some = request.allow.slice(at, at + size)
    try {
      const a = await ctap.getAssertion(key.ch, null, null, { rpId: request.rpId, clientDataHash: Buffer.alloc(32), allow: some, silent: true }, { timeout: 3000 })
      return a.credentialId ? [{ id: a.credentialId }] : some
    } catch (e) { if (!(e instanceof ctap.KeyError) || e.status !== S.NO_CREDENTIALS) return undefined }
  }
  return null
}

// Several keys, one person: every key waits for a touch, the first one touched is the one, the rest are let go.
function chosen (keys, wait) {
  return new Promise((resolve, reject) => {
    let waiting = keys.length; let done = false
    const out = (problem) => { if (--waiting === 0 && !done) reject(new Stop(problem)) }
    for (const k of keys) {
      ctap.touched(k.ch, k, { timeout: wait }).then((yes) => {
        if (!yes || done) return out(null)
        done = true
        // The others are told to stop waiting — and told before anything else happens to them: a key nobody
        // cancelled goes on blinking for a touch until it gives up by itself.
        Promise.all(keys.filter(other => other !== k).map(other => other.ch.cancel())).then(() => resolve(k))
      }, () => out('gone'))
    }
  })
}

// The key's public key as the web reads it (SubjectPublicKeyInfo), from the bytes the key answered with.
function attested (authData) {
  const length = authData.readUInt16BE(53)
  const id = authData.subarray(55, 55 + length)
  let spki = null; let alg = null
  try {
    const key = cbor.decodeFirst(authData.subarray(55 + length)).value
    alg = key.get(3)
    if (key.get(1) === 2 && key.get(-1) === 1) spki = crypto.createPublicKey({ format: 'jwk', key: { kty: 'EC', crv: 'P-256', x: b64u(key.get(-2)), y: b64u(key.get(-3)) } }).export({ type: 'spki', format: 'der' })
  } catch {}
  return { id, spki, alg }
}

/**
 * Run one ceremony. Resolves `{ native: true }` when it is not the Desktop's to run — no key here needs its PIN asked,
 * so Chromium does what it always did — or `{ credential }`, every byte string in base64url. Rejects with a Refusal.
 */
async function ceremony ({ kind, origin, publicKey, ui, discover = hid.keys, patience }) {
  const request = read(kind, origin, publicKey)
  if (patience) request.timeout = patience   // a test's clock; a page's timeout is held to the limits in read()
  const keys = await plugged(discover)
  const close = (except) => { for (const k of keys) if (k !== except) k.ch.close() }
  // WHOSE CEREMONY IT IS. Chromium serves a key that verifies its user by itself (a fingerprint reader) and any key
  // when verification is not required. What it cannot serve is the rest, when it is: those are the Desktop's.
  const outside = keys.filter(k => k.options.uv !== true)
  if (request.userVerification !== 'required' || outside.length === 0) { close(); return { native: true } }

  const view = (step, more) => ({ step, kind, origin: request.origin, rpId: request.rpId, ...more })
  const stop = new AbortController()
  const timer = setTimeout(() => stop.abort('timeout'), request.timeout)
  const onClose = () => stop.abort('cancel')
  if (ui.signal.aborted) onClose(); else ui.signal.addEventListener('abort', onClose, { once: true })
  let key = null
  // Whatever is waiting on a key is told to stop when the person closes the window or time runs out.
  stop.signal.addEventListener('abort', () => { for (const k of keys) k.ch.cancel() }, { once: true })
  const aborted = new Promise((resolve, reject) => stop.signal.addEventListener('abort', () => reject(new Stop(null)), { once: true }))
  aborted.catch(() => {})
  const until = (p) => Promise.race([p, aborted])
  const left = () => Math.max(1000, request.timeout)
  // What a key's refusal means to the person, where it means something.
  const refused = (e) => {
    if (!(e instanceof ctap.KeyError)) return new Stop('gone')
    if (e.status === S.KEEPALIVE_CANCEL) return new Stop(null)
    if (e.status === S.USER_ACTION_TIMEOUT || e.status === S.OPERATION_DENIED) return new Stop('timeout')
    if (e.status === S.CREDENTIAL_EXCLUDED) return new Stop('excluded', 'InvalidStateError')
    if (e.status === S.UNSUPPORTED_ALGORITHM) return new Stop('unsupported', 'NotSupportedError')
    if (e.status === S.NO_CREDENTIALS) return new Stop('unknown-key')
    if (e.status === S.KEY_STORE_FULL) return new Stop('full')
    if (e.status === S.PIN_BLOCKED) return new Stop('blocked')
    if (e.status === S.PIN_AUTH_BLOCKED) return new Stop('replug')
    if (e.status === S.PIN_NOT_SET) return new Stop('no-pin')
    return new Stop('key-error')
  }

  try {
    let able = outside.filter(k => k.options.clientPin === true && pinProtocol.choose(k.protocols))
    if (able.length === 0) throw new Stop('no-pin')
    if (kind === 'get' && request.allow.length > 0) {
      const knows = []
      for (const k of able) { const held = await holds(k, request); if (held !== null) knows.push({ k, held }) }
      if (knows.length === 0) throw new Stop('unknown-key')
      able = knows.map(({ k, held }) => Object.assign(k, { allow: held || request.allow }))
    }
    key = able[0]
    if (able.length > 1) { ui.tell(view('choose', { count: able.length })); key = await until(chosen(able, left())) }
    close(key)
    const protocol = pinProtocol.choose(key.protocols)

    let retries = await ctap.retries(key.ch, protocol)
    let token = null; let problem = null
    while (token === null) {
      if (retries === 0) throw new Stop('blocked')
      const pin = await until(ui.askPin(view('pin', { key: key.name, retries, problem, minPinLength: key.minPinLength })))
      if (pin === null || pin === undefined) throw new Stop(null)
      // A PIN that cannot be one never reaches the key, and so costs nothing.
      problem = pinProtocol.shape(pin, key.minPinLength)
      if (problem) continue
      ui.tell(view('checking', { key: key.name }))
      try {
        token = await ctap.pinToken(key.ch, key, protocol, pin, { permission: kind === 'create' ? ctap.PERMISSION.makeCredential : ctap.PERMISSION.getAssertion, rpId: request.rpId })
      } catch (e) {
        if (!(e instanceof ctap.KeyError) || e.status !== S.PIN_INVALID) throw refused(e)
        // THE KEY REFUSED THIS PIN. It is not sent again: the person is asked again, and told what is left.
        retries = await ctap.retries(key.ch, protocol)
        problem = 'wrong-pin'
      }
    }

    if (stop.signal.aborted) throw new Stop(null)
    const type = kind === 'create' ? 'webauthn.create' : 'webauthn.get'
    // THE ORIGIN IS WRITTEN HERE, from the frame that asked — it is what the key's signature binds, and what the
    // house checks. The page does not get to say where it is.
    const clientDataJSON = Buffer.from(JSON.stringify({ type, challenge: b64u(request.challenge), origin: request.origin, crossOrigin: false }), 'utf8')
    const clientDataHash = sha256(clientDataJSON)
    const opts = { timeout: left(), onKeepalive: (status) => { if (status === hid.KEEPALIVE.TOUCH) ui.tell(view('touch', { key: key.name })) } }
    ui.tell(view('touch', { key: key.name }))

    let credential
    if (kind === 'create') {
      let made
      try { made = await ctap.makeCredential(key.ch, protocol, token, { clientDataHash, rp: request.rp, user: request.user, params: request.params, exclude: request.exclude, residentKey: request.residentKey }, opts) } catch (e) { throw refused(e) }
      // The house asked for a verified user. A key that answers without saying so is not handed on as if it had.
      if (!Buffer.isBuffer(made.authData) || made.authData.length < 55 || !(made.authData[32] & 0x04)) throw new Stop('unverified')
      let { fmt, attStmt, authData } = made
      // What model of key this is, is told only to a page that asked (WebAuthn §5.4.7, attestation «none»).
      if (request.attestation === 'none') { fmt = 'none'; attStmt = new Map(); authData = Buffer.from(authData); authData.fill(0, 37, 53) }
      const { id, spki, alg } = attested(authData)
      credential = {
        type: 'public-key', id: b64u(id), rawId: b64u(id), authenticatorAttachment: 'cross-platform',
        response: {
          clientDataJSON: b64u(clientDataJSON), attestationObject: b64u(cbor.encode(new Map([['fmt', fmt], ['attStmt', attStmt], ['authData', authData]]))),
          authenticatorData: b64u(authData), publicKey: spki ? b64u(spki) : null, publicKeyAlgorithm: alg, transports: ['usb'],
        },
      }
    } else {
      let signed
      try { signed = await ctap.getAssertion(key.ch, protocol, token, { rpId: request.rpId, clientDataHash, allow: key.allow || request.allow }, opts) } catch (e) { throw refused(e) }
      if (!Buffer.isBuffer(signed.authData) || signed.authData.length < 37 || !(signed.authData[32] & 0x04)) throw new Stop('unverified')
      if (!signed.credentialId) throw new Stop('key-error')
      credential = {
        type: 'public-key', id: b64u(signed.credentialId), rawId: b64u(signed.credentialId), authenticatorAttachment: 'cross-platform',
        response: { clientDataJSON: b64u(clientDataJSON), authenticatorData: b64u(signed.authData), signature: b64u(signed.signature), userHandle: signed.userHandle ? b64u(signed.userHandle) : null },
      }
    }
    ui.tell(view('done', { key: key.name }))
    return { credential }
  } catch (e) {
    const timedOut = stop.signal.aborted && stop.signal.reason === 'timeout'
    const end = e instanceof Stop ? e : (e instanceof ctap.KeyError ? refused(e) : new Stop('gone'))
    const problem = timedOut ? 'timeout' : end.problem
    // A failure is read before it is gone: the window stays on it until the person closes it.
    if (problem && !(stop.signal.aborted && stop.signal.reason === 'cancel')) { try { await ui.acknowledge(view('failed', { problem, key: key ? key.name : null })) } catch {} }
    throw new Refusal(end.dom)
  } finally {
    clearTimeout(timer)
    ui.signal.removeEventListener('abort', onClose)
    close()
  }
}

module.exports = { ceremony, read, Refusal, WORDS }
