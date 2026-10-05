// The Desktop's own passkey client for a security key with a PIN (greenhouse decisions/0568) — plain node, no
// Electron, and NO REAL KEY: every key here is test/virtual-key.js on a socket in a temp directory. What is measured:
// the PIN's math against Yubico's, the wire, and the ceremony — above all that a wrong PIN reaches the key once.
// Exits non-zero on a failure.
//
// (c) Rodrigo Vicente - TeamX Agency — Apache-2.0
'use strict'
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const crypto = require('node:crypto')
const cbor = require('../security-key/cbor.js')
const pin = require('../security-key/pin.js')
const hid = require('../security-key/hid.js')
const { ceremony, read } = require('../security-key/ceremony.js')
const { virtualKey } = require('./virtual-key.js')

const checks = []
function record (name, ok, detail) { checks.push({ name, ok: !!ok }); console.log((ok ? 'PASS' : 'FAIL') + ' · ' + name + (ok || detail === undefined ? '' : ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)))) }
const H = (s) => Buffer.from(s, 'hex')
const b64u = (b) => Buffer.from(b).toString('base64url')
const sha256 = (b) => crypto.createHash('sha256').update(b).digest()
const sleep = (ms) => new Promise(r => setTimeout(r, ms))
const ORIGIN = 'http://localhost:8899'
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-'))
let n = 0
const plug = (opts) => virtualKey(opts).listen(path.join(DIR, 'k' + (n++)))
// NO REAL KEY, WHATEVER THE CODE UNDER TEST DOES. The keys are named, and the places a key would be LOOKED for are an
// empty directory of this test's — so that code which wrongly goes looking (a bug, or a mutant of a mutation run:
// one did, and reached a person's keys) finds nothing, instead of the machine's real /sys/class/hidraw.
const NOWHERE = path.join(DIR, 'nowhere'); fs.mkdirSync(NOWHERE)
const named = (...keys) => () => hid.keys({ env: { MILPA_SECURITY_KEYS: keys.map(k => k.path).join(',') }, sys: NOWHERE, dev: NOWHERE })

// The Desktop's window, as a script: the PINs it will type, in order (null: it closes the window instead).
function person (pins = []) {
  const stop = new AbortController()
  const ui = { views: [], asked: 0, acknowledged: [], signal: stop.signal, close: () => stop.abort(), onView: null }
  const see = (v) => { ui.views.push(v); if (ui.onView) ui.onView(v) }
  ui.tell = see
  ui.askPin = async (v) => { see(v); ui.asked++; return pins.length ? pins.shift() : null }
  ui.acknowledge = async (v) => { see(v); ui.acknowledged.push(v.problem) }
  ui.steps = () => ui.views.map(v => v.step + (v.problem ? ':' + v.problem : '')).filter((s, i, a) => s !== a[i - 1])
  return ui
}
const creation = (more = {}) => ({
  rp: { id: 'localhost', name: 'Milpa' }, user: { id: b64u(crypto.randomBytes(16)), name: 'operator', displayName: 'Operator' },
  challenge: b64u(crypto.randomBytes(32)), pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
  authenticatorSelection: { userVerification: 'required', residentKey: 'discouraged' }, timeout: 60000, ...more,
})
const request = (ids, more = {}) => ({ challenge: b64u(crypto.randomBytes(32)), rpId: 'localhost', allowCredentials: ids.map(id => ({ type: 'public-key', id })), userVerification: 'required', timeout: 60000, ...more })
const refusal = async (p) => { try { await p; return null } catch (e) { return e } }
const count = (key, what) => key.said().filter(s => s === what).length
const enroll = async (key, pinValue = '1234') => (await ceremony({ kind: 'create', origin: ORIGIN, publicKey: creation(), ui: person([pinValue]), discover: named(key) })).credential

async function main () {
  // ── the bytes ──
  const m = new Map([[3, 'x'], [1, H('6162')], ['fmt', 'none'], [-1, [1, true, false]], ['attStmt', new Map()]])
  record('cbor: a map is written with its keys in the order a key expects, and reads back the same', cbor.encode(m).toString('hex') === 'a501426162036178208301f5f463666d74646e6f6e656761747453746d74a0' && cbor.encode(cbor.decode(cbor.encode(m))).equals(cbor.encode(m)), cbor.encode(m).toString('hex'))
  const bad = [H('a1'), H('0000'), H('fb3ff0000000000000'), H('5f')].filter(b => { try { cbor.decode(b); return true } catch { return false } })
  record('cbor: a message cut short, bytes after it, a float and an endless string are refused [negative control]', bad.length === 0, bad.map(b => b.toString('hex')))

  const vectors = require('./pin-vectors.json')
  const wrong = vectors.cases.filter((c) => {
    const p = pin.PROTOCOLS[c.protocol]
    const { secret } = pin.encapsulate(p, new Map([[-2, H(c.key_x)], [-3, H(c.key_y)]]), { privateKey: H(c.platform_private) })
    return !(secret.equals(H(c.secret)) && pin.pinHashEnc(p, secret, c.pin, { iv: c.iv ? H(c.iv) : undefined }).equals(H(c.pin_hash_enc)) && p.decrypt(secret, H(c.token_enc)).equals(H(c.token)) && p.authenticate(H(c.token), H(c.message)).equals(H(c.auth)))
  })
  record(`pin: the shared secret, the PIN's proof, the token and its signature are byte for byte ${vectors.from}'s — ${vectors.cases.length} cases, protocols one and two`, vectors.cases.length >= 10 && wrong.length === 0, wrong.map(c => c.protocol + ':' + c.pin))
  record('pin: three characters, nothing, and sixty-four bytes are not a PIN; four characters and an accented one are', pin.shape('123') === 'too-short' && pin.shape('') === 'too-short' && pin.shape(null) === 'too-short' && pin.shape('x'.repeat(64)) === 'too-long' && pin.shape('1234') === null && pin.shape('ñandú') === null && pin.shape('123456', 8) === 'too-short')
  record('pin: a key that lists protocols this does not speak gets none, and one that lists none gets protocol one', pin.choose([7, 9]) === null && pin.choose(undefined).version === 1 && pin.choose([2, 1]).version === 2 && pin.choose([1, 2]).version === 1)

  // ── where the keys are ──
  const sys = path.join(DIR, 'sys'); const dev = path.join(DIR, 'dev')
  const device = (node, descriptor, name) => { fs.mkdirSync(path.join(sys, node, 'device'), { recursive: true }); fs.writeFileSync(path.join(sys, node, 'device', 'report_descriptor'), H(descriptor)); fs.writeFileSync(path.join(sys, node, 'device', 'uevent'), `DRIVER=hid-generic\nHID_NAME=${name}\n`) }
  device('hidraw0', '05010906a101050719e029e7', 'Yubico YubiKey OTP+FIDO+CCID')    // its keyboard
  device('hidraw4', '06d0f10901a1010920150026ff007508954081020921150026ff00750895409102c0', 'Yubico YubiKey OTP+FIDO+CCID')
  device('hidraw2', '0600ff0901a101', 'A vendor thing')
  const found = hid.keys({ env: {}, platform: 'linux', sys, dev })
  record('keys: of a key\'s two devices only the security-key one is found — not its keyboard, not a vendor device', found.length === 1 && found[0].path === path.join(dev, 'hidraw4') && found[0].name === 'Yubico YubiKey OTP+FIDO+CCID', found.map(f => f.path))
  record('keys: on a machine that is not Linux, none are looked for', hid.keys({ env: {}, platform: 'darwin', sys, dev }).length === 0)
  const lab = await plug()
  const onlyNamed = hid.keys({ env: { MILPA_SECURITY_KEYS: lab.path + ', ' + path.join(DIR, 'missing') }, platform: 'linux', sys, dev })
  record('keys: MILPA_SECURITY_KEYS names them — only those, and the plugged-in ones are not looked for', onlyNamed.length === 1 && onlyNamed[0].path === lab.path, onlyNamed.map(f => f.path))
  record('keys: named as nothing, there are none', hid.keys({ env: { MILPA_SECURITY_KEYS: '' }, platform: 'linux', sys, dev }).length === 0)

  // ── the request, before any key is spoken to ──
  const notRead = [
    ['a relying party that is not the page\'s host', () => read('create', ORIGIN, creation({ rp: { id: 'evil.example' } })), 'SecurityError'],
    ['a parent of another host', () => read('get', 'http://localhost:8899', request([], { rpId: 'host' })), 'SecurityError'],
    ['no challenge', () => read('create', ORIGIN, creation({ challenge: '' })), 'TypeError'],
    ['no user id', () => read('create', ORIGIN, creation({ user: { name: 'x' } })), 'TypeError'],
    ['no algorithm', () => read('create', ORIGIN, creation({ pubKeyCredParams: [] })), 'NotSupportedError'],
    ['nothing', () => read('create', ORIGIN, null), 'TypeError'],
    ['another verb', () => read('store', ORIGIN, creation()), 'TypeError'],
  ].filter(([, f, name]) => { try { f(); return true } catch (e) { return e.name !== name } })
  record('request: another relying party, no challenge, no user, no algorithm, nothing at all are refused before any key [negative control]', notRead.length === 0, notRead.map(x => x[0]))
  record('request: a page on a subdomain may name its parent; the timeout is held between 15 s and 10 min', read('get', 'https://panel.milpa.example', request([], { rpId: 'milpa.example' })).rpId === 'milpa.example' && read('get', ORIGIN, request([], { timeout: 5 })).timeout === 15000 && read('get', ORIGIN, request([], { timeout: 9e9 })).timeout === 600000)

  // ── a ceremony: register ──
  const key = await plug()
  let ui = person(['1234'])
  const options = creation({ attestation: 'direct', origin: 'https://evil.example' })
  const made = (await ceremony({ kind: 'create', origin: ORIGIN, publicKey: options, ui, discover: named(key) })).credential
  const clientData = JSON.parse(Buffer.from(made.response.clientDataJSON, 'base64url'))
  const att = cbor.decode(Buffer.from(made.response.attestationObject, 'base64url'))
  const authData = att.get('authData')
  record('register: the right PIN, a touch, and the key answers with a credential', made.type === 'public-key' && made.id === made.rawId && Buffer.from(made.rawId, 'base64url').length === 32 && key.credentials.has(Buffer.from(made.rawId, 'base64url').toString('hex')))
  record('register: what the person saw — the PIN asked with 8 attempts left, checking, touch, done', JSON.stringify(ui.steps()) === JSON.stringify(['pin', 'checking', 'touch', 'done']) && ui.views[0].retries === 8 && ui.views[0].origin === ORIGIN && ui.views[0].kind === 'create', ui.steps())
  record('register: what the key was sent — who are you, attempts left, the PIN\'s proof once, the credential', JSON.stringify(key.said()) === JSON.stringify(['getInfo', 'clientPin:retries', 'clientPin:keyAgreement', 'clientPin:pinTokenWithPermissions', 'makeCredential']), key.said())
  record('register: the origin the key signed over is the one the Desktop was given, whatever the page put in its request', clientData.origin === ORIGIN && clientData.type === 'webauthn.create' && clientData.challenge === options.challenge && clientData.crossOrigin === false, clientData)
  record('register: the answer says the user was verified, for this relying party', (authData[32] & 0x05) === 0x05 && authData.subarray(0, 32).equals(sha256(Buffer.from('localhost'))))
  const publicKey = crypto.createPublicKey({ key: Buffer.from(made.response.publicKey, 'base64url'), format: 'der', type: 'spki' })
  record('register: asked for the key\'s own attestation, it is handed on whole and it verifies', att.get('fmt') === 'packed' && crypto.verify('sha256', Buffer.concat([authData, sha256(Buffer.from(made.response.clientDataJSON, 'base64url'))]), publicKey, att.get('attStmt').get('sig')))
  const plain = (await ceremony({ kind: 'create', origin: ORIGIN, publicKey: creation(), ui: person(['1234']), discover: named(key) })).credential
  const plainAtt = cbor.decode(Buffer.from(plain.response.attestationObject, 'base64url'))
  record('register: not asked for it, the page is not told what model of key this is', plainAtt.get('fmt') === 'none' && plainAtt.get('attStmt').size === 0 && plainAtt.get('authData').subarray(37, 53).equals(Buffer.alloc(16)) && [...plainAtt.keys()].join() === 'fmt,attStmt,authData')
  record('register: the PIN is in nothing the window was shown and nothing the key logged', !JSON.stringify(ui.views).includes('1234') && !JSON.stringify(key.log).includes('1234'))

  // ── a ceremony: sign in ──
  ui = person(['1234'])
  const ask = request([b64u(crypto.randomBytes(32)), made.rawId])
  const signed = (await ceremony({ kind: 'get', origin: ORIGIN, publicKey: ask, ui, discover: named(key) })).credential
  const signedData = Buffer.from(signed.response.authenticatorData, 'base64url')
  record('sign in: the key signs, and the signature verifies under the key it registered — with the user verified', signed.rawId === made.rawId && (signedData[32] & 0x05) === 0x05 && crypto.verify('sha256', Buffer.concat([signedData, sha256(Buffer.from(signed.response.clientDataJSON, 'base64url'))]), publicKey, Buffer.from(signed.response.signature, 'base64url')))
  record('sign in: the challenge and the origin signed are this request\'s', (() => { const c = JSON.parse(Buffer.from(signed.response.clientDataJSON, 'base64url')); return c.type === 'webauthn.get' && c.challenge === ask.challenge && c.origin === ORIGIN })())

  // ── a wrong PIN ──
  const k2 = await plug()
  ui = person(['0000', null])
  let err = await refusal(ceremony({ kind: 'create', origin: ORIGIN, publicKey: creation(), ui, discover: named(k2) }))
  record('wrong PIN: it reached the key ONCE, the person is asked again and told 7 attempts are left — and closing the window ends it', count(k2, 'clientPin:pinTokenWithPermissions') === 1 && k2.retries === 7 && JSON.stringify(ui.steps()) === JSON.stringify(['pin', 'checking', 'pin:wrong-pin']) && ui.views[ui.views.length - 1].retries === 7 && err && err.name === 'NotAllowedError', { said: k2.said(), steps: ui.steps(), retries: k2.retries })
  record('wrong PIN: no credential was asked of the key, and the page is told no more than a browser tells it', count(k2, 'makeCredential') === 0 && err.message === 'The operation either timed out or was not allowed.', err && err.message)
  ui = person(['0000', '1234'])
  const after = await refusal(ceremony({ kind: 'create', origin: ORIGIN, publicKey: creation(), ui, discover: named(k2) }))
  record('wrong PIN, then the right one typed: registered, and the key has its 8 attempts back', after === null && k2.retries === 8 && ui.views.find(v => v.problem === 'wrong-pin').retries === 6 && count(k2, 'clientPin:pinTokenWithPermissions') === 3, { steps: ui.steps(), retries: k2.retries })
  const k3 = await plug()
  ui = person(['12', '', 'x'.repeat(70), null])
  await refusal(ceremony({ kind: 'create', origin: ORIGIN, publicKey: creation(), ui, discover: named(k3) }))
  record('a PIN that cannot be one — two characters, nothing, seventy — never reaches the key and costs no attempt', count(k3, 'clientPin:pinTokenWithPermissions') === 0 && count(k3, 'clientPin:keyAgreement') === 0 && k3.retries === 8 && JSON.stringify(ui.steps()) === JSON.stringify(['pin', 'pin:too-short', 'pin:too-long']), { said: k3.said(), steps: ui.steps() })
  ui = person(['0000', '1111', '2222', '1234', '1234'])
  err = await refusal(ceremony({ kind: 'create', origin: ORIGIN, publicKey: creation(), ui, discover: named(k3) }))
  record('three wrong PINs in a row: the key wants to be unplugged — the person is told so, and the PIN typed next is never sent', count(k3, 'clientPin:pinTokenWithPermissions') === 3 && k3.retries === 5 && ui.asked === 3 && JSON.stringify(ui.acknowledged) === JSON.stringify(['replug']) && err.name === 'NotAllowedError', { said: k3.said(), steps: ui.steps(), asked: ui.asked })
  const k4 = await plug({ attempts: 2 })
  await refusal(ceremony({ kind: 'create', origin: ORIGIN, publicKey: creation(), ui: person(['0000', '1111', '1234']), discover: named(k4) }))
  ui = person(['1234'])
  await refusal(ceremony({ kind: 'create', origin: ORIGIN, publicKey: creation(), ui, discover: named(k4) }))
  record('a key with no attempts left: the person is told it is blocked and is not asked for a PIN', k4.retries === 0 && ui.asked === 0 && JSON.stringify(ui.acknowledged) === JSON.stringify(['blocked']) && count(k4, 'clientPin:pinTokenWithPermissions') === 2, { said: k4.said(), steps: ui.steps() })

  // ── whose ceremony it is ──
  const noPin = await plug({ pin: null })
  ui = person(['1234'])
  err = await refusal(ceremony({ kind: 'create', origin: ORIGIN, publicKey: creation(), ui, discover: named(noPin) }))
  record('a key with no PIN set cannot verify anybody: the person is told, no PIN is asked, nothing is registered', ui.asked === 0 && JSON.stringify(ui.acknowledged) === JSON.stringify(['no-pin']) && noPin.credentials.size === 0 && err.name === 'NotAllowedError', ui.steps())
  const k5 = await plug()
  ui = person(['1234'])
  const preferred = await ceremony({ kind: 'create', origin: ORIGIN, publicKey: creation({ authenticatorSelection: { userVerification: 'preferred' } }), ui, discover: named(k5) })
  record('verification not required: it is Chromium\'s ceremony, as before — the key is asked what it is and nothing else', preferred.native === true && ui.views.length === 0 && JSON.stringify(k5.said()) === JSON.stringify(['getInfo']), k5.said())
  const bio = await plug({ uv: true })
  const byItself = await ceremony({ kind: 'create', origin: ORIGIN, publicKey: creation(), ui: person(['1234']), discover: named(bio) })
  record('a key that verifies its user by itself (a fingerprint reader): Chromium\'s, as before', byItself.native === true && JSON.stringify(bio.said()) === JSON.stringify(['getInfo']))
  const nobody = await ceremony({ kind: 'get', origin: ORIGIN, publicKey: request([made.rawId]), ui: person(['1234']), discover: () => [] })
  record('no key plugged in: Chromium\'s, as before', nobody.native === true)
  const u2f = await plug({ cbor: false })
  const old = await ceremony({ kind: 'create', origin: ORIGIN, publicKey: creation(), ui: person(['1234']), discover: named(u2f) })
  record('a key that only speaks U2F: left to Chromium, and sent nothing', old.native === true && u2f.log.length === 0)

  // ── several keys ──
  const a = await plug({ touch: 'manual', versions: ['FIDO_2_0'] }); const b = await plug({ touch: 'manual' }); const c = await plug({ touch: 'manual', versions: ['FIDO_2_0'] })
  ui = person(['1234'])
  ui.onView = async (v) => { if (v.step === 'choose') { await sleep(150); b.touch() } else if (v.step === 'touch') { await sleep(50); b.touch() } }
  const among = await refusal(ceremony({ kind: 'create', origin: ORIGIN, publicKey: creation(), ui, discover: named(a, b, c) }))
  await sleep(100)
  record('three keys plugged in: the person touches one, and that one is asked for its PIN', among === null && JSON.stringify(ui.steps()) === JSON.stringify(['choose', 'pin', 'checking', 'touch', 'done']) && ui.views[0].count === 3 && b.credentials.size === 1, ui.steps())
  record('…the other two are let go: never sent a PIN, nothing registered on them, their attempts untouched', [a, c].every(k => k.credentials.size === 0 && k.retries === 8 && !k.said().some(s => /pinToken|keyAgreement/.test(s)) && k.log.filter(e => e.command === 'makeCredential').every(e => e.probe && e.status === 0x2d)), [a.said(), c.said(), a.log.map(e => e.status)])
  ui = person(['1234'])
  a.touches = 0
  ui.onView = async (v) => { if (v.step === 'choose') { await sleep(150); a.touch() } else if (v.step === 'touch') { await sleep(50); a.touch() } }
  const older = await refusal(ceremony({ kind: 'create', origin: ORIGIN, publicKey: creation(), ui, discover: named(a, b, c) }))
  record('an older key (CTAP 2.0) is chosen by touch too, and being chosen costs it no attempt', older === null && a.credentials.size === 1 && a.retries === 8 && a.log.some(e => e.probe && e.status === 0x31), a.said())
  const [idB] = [...b.credentials.keys()].map(h => b64u(H(h)))
  ui = person(['1234'])
  ui.onView = async (v) => { if (v.step === 'touch') { await sleep(50); b.touch() } }
  const which = await ceremony({ kind: 'get', origin: ORIGIN, publicKey: request([b64u(crypto.randomBytes(32)), idB]), ui, discover: named(a, b, c) })
  record('signing in with three keys plugged in: the one this house knows is found without a touch — nobody is asked to choose', which.credential.rawId === idB && !ui.steps().includes('choose') && a.said().filter(s => s === 'getAssertion:silent').length === 1 && !c.said().some(s => /pinToken/.test(s)), ui.steps())
  ui = person(['1234'])
  err = await refusal(ceremony({ kind: 'get', origin: ORIGIN, publicKey: request([b64u(crypto.randomBytes(32))]), ui, discover: named(key) }))
  record('a key this house does not know: the person is told before any PIN is asked', ui.asked === 0 && JSON.stringify(ui.acknowledged) === JSON.stringify(['unknown-key']) && err.name === 'NotAllowedError' && !key.said().slice(-3).some(s => /pinToken/.test(s)), ui.steps())

  // ── the window is closed, time runs out ──
  const slow = await plug({ touch: 'manual' })
  ui = person(['1234'])
  const closing = ui
  ui.onView = async (v) => { if (v.step === 'touch') { await sleep(120); closing.close() } }
  err = await refusal(ceremony({ kind: 'create', origin: ORIGIN, publicKey: creation(), ui, discover: named(slow) }))
  record('the window closed while the key waits for a touch: the key is told to stop, nothing is registered, nothing more is shown', err.name === 'NotAllowedError' && slow.credentials.size === 0 && slow.log[slow.log.length - 1].status === 0x2d && ui.acknowledged.length === 0, slow.log.slice(-1))
  ui = person(['1234'])
  err = await refusal(ceremony({ kind: 'create', origin: ORIGIN, publicKey: creation(), ui, discover: named(slow), patience: 400 }))
  record('nobody touches the key in time: the key is told to stop and the person is told it took too long', err.name === 'NotAllowedError' && slow.credentials.size === 0 && JSON.stringify(ui.acknowledged) === JSON.stringify(['timeout']) && slow.log[slow.log.length - 1].status === 0x2d, ui.steps())

  // ── keys that differ ──
  const first = await enroll(key)
  ui = person(['1234'])
  err = await refusal(ceremony({ kind: 'create', origin: ORIGIN, publicKey: creation({ excludeCredentials: [{ type: 'public-key', id: first.rawId }] }), ui, discover: named(key) }))
  record('a key already registered here, when the house says not twice: InvalidStateError, and the person is told', err && err.name === 'InvalidStateError' && JSON.stringify(ui.acknowledged) === JSON.stringify(['excluded']), [err && err.name, ui.steps(), key.log.slice(-2)])
  err = await refusal(ceremony({ kind: 'create', origin: ORIGIN, publicKey: creation({ pubKeyCredParams: [{ type: 'public-key', alg: -257 }] }), ui: person(['1234']), discover: named(key) }))
  record('an algorithm the key does not have: NotSupportedError', err.name === 'NotSupportedError')
  const one = await plug({ protocols: [1], scopedToken: false, versions: ['FIDO_2_0'], omitsCredential: true })
  const oldMade = await enroll(one)
  const oldSigned = (await ceremony({ kind: 'get', origin: ORIGIN, publicKey: request([oldMade.rawId]), ui: person(['1234']), discover: named(one) })).credential
  record('a key that only speaks the first PIN protocol, with tokens that are not scoped, and leaves the credential out of its answer: registers and signs in', oldSigned.rawId === oldMade.rawId && one.said().includes('clientPin:pinToken') && !one.said().includes('clientPin:pinTokenWithPermissions'), one.said())
  const small = await plug({ maxCredentialsInList: 2 })
  const mine = await enroll(small)
  const many = [1, 2, 3, 4, 5].map(() => b64u(crypto.randomBytes(32))); many.splice(3, 0, mine.rawId)
  const found2 = (await ceremony({ kind: 'get', origin: ORIGIN, publicKey: request(many), ui: person(['1234']), discover: named(small) })).credential
  record('a house with more credentials than the key takes in one message: asked in pieces, and the one it holds signs', found2.rawId === mine.rawId && small.log.filter(e => e.command === 'getAssertion').every(e => e.allow <= 2), small.log.filter(e => e.command === 'getAssertion').map(e => e.allow))
  const forgetful = await plug({ forgetsVerification: true })
  ui = person(['1234'])
  err = await refusal(ceremony({ kind: 'create', origin: ORIGIN, publicKey: creation(), ui, discover: named(forgetful) }))
  const [held] = [...forgetful.credentials.keys()].map(h => b64u(H(h)))
  const ui2 = person(['1234'])
  const err2 = await refusal(ceremony({ kind: 'get', origin: ORIGIN, publicKey: request([held]), ui: ui2, discover: named(forgetful) }))
  record('a key that answers without saying the user was verified: its answer is not handed on as if it had, registering or signing in [negative control]', err && err.name === 'NotAllowedError' && JSON.stringify(ui.acknowledged) === JSON.stringify(['unverified']) && err2 && err2.name === 'NotAllowedError' && JSON.stringify(ui2.acknowledged) === JSON.stringify(['unverified']), [ui.steps(), ui2.steps()])

  for (const k of [forgetful, lab, key, k2, k3, k4, noPin, k5, bio, u2f, a, b, c, slow, one, small]) await k.close()
}

main().catch((e) => record('the tests ran without throwing', false, String(e && e.stack || e))).finally(() => {
  try { fs.rmSync(DIR, { recursive: true, force: true }) } catch {}
  const failed = checks.filter(c => !c.ok)
  console.log('\n' + (checks.length - failed.length) + '/' + checks.length + ' security-key checks passed')
  process.exit(failed.length ? 1 : 0)
})
