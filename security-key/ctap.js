// What is said to a security key (FIDO CTAP 2.1 §6): who are you, how many PIN attempts are left, here is the PIN's
// proof, make a credential, sign this. One function per thing said; none of them decides anything, and NONE OF THEM
// EVER SAYS A THING TWICE — a PIN the key refused is reported to whoever asked, with the key's own code.
//
// (c) Rodrigo Vicente - TeamX Agency — Apache-2.0
'use strict'
const cbor = require('./cbor.js')
const pinProtocol = require('./pin.js')

const COMMAND = { makeCredential: 0x01, getAssertion: 0x02, getInfo: 0x04, clientPin: 0x06, selection: 0x0b }
const SUB = { retries: 1, keyAgreement: 2, pinToken: 5, pinTokenWithPermissions: 9 }
const PERMISSION = { makeCredential: 1, getAssertion: 2 }
const STATUS = {
  OK: 0x00, INVALID_COMMAND: 0x01, CREDENTIAL_EXCLUDED: 0x19, UNSUPPORTED_ALGORITHM: 0x26, OPERATION_DENIED: 0x27, KEY_STORE_FULL: 0x28,
  KEEPALIVE_CANCEL: 0x2d, NO_CREDENTIALS: 0x2e, USER_ACTION_TIMEOUT: 0x2f, PIN_INVALID: 0x31, PIN_BLOCKED: 0x32,
  PIN_AUTH_INVALID: 0x33, PIN_AUTH_BLOCKED: 0x34, PIN_NOT_SET: 0x35, PUAT_REQUIRED: 0x36, PIN_POLICY_VIOLATION: 0x37,
}

class KeyError extends Error {
  constructor (status) {
    const name = Object.keys(STATUS).find(k => STATUS[k] === status)
    super('the key answered ' + (name || 'an error') + ' (0x' + status.toString(16).padStart(2, '0') + ')')
    this.status = status
  }
}

async function say (ch, command, params, opts) {
  const body = params === undefined ? Buffer.from([command]) : Buffer.concat([Buffer.from([command]), cbor.encode(params)])
  const answer = await ch.cbor(body, opts)
  if (answer.length === 0) throw new Error('the key answered nothing')
  if (answer[0] !== STATUS.OK) throw new KeyError(answer[0])
  return answer.length > 1 ? cbor.decode(answer.subarray(1)) : new Map()
}

/** What the key is: its versions, whether it has a PIN (`clientPin`), whether it verifies its user by itself (`uv`). */
async function info (ch) {
  const m = await say(ch, COMMAND.getInfo, undefined, { timeout: 3000 })
  const options = m.get(4) instanceof Map ? Object.fromEntries(m.get(4)) : {}
  return {
    versions: m.get(1) || [], options, protocols: m.get(6) || [1],
    maxCredentialsInList: m.get(7) || null, minPinLength: m.get(13) || 4,
  }
}

/** How many PIN attempts the key has left before it must be reset. Asking costs none. */
async function retries (ch, protocol) {
  const m = await say(ch, COMMAND.clientPin, new Map([[1, protocol.version], [2, SUB.retries]]), { timeout: 3000 })
  return m.get(3)
}

/**
 * Prove the PIN to the key, once, and get its token for one ceremony. A wrong PIN throws KeyError(PIN_INVALID) and
 * has cost one attempt; this function does not try again.
 */
async function pinToken (ch, key, protocol, pin, { permission, rpId }) {
  const agreement = await say(ch, COMMAND.clientPin, new Map([[1, protocol.version], [2, SUB.keyAgreement]]), { timeout: 3000 })
  const { secret, platformKey } = pinProtocol.encapsulate(protocol, agreement.get(1))
  const scoped = key.options.pinUvAuthToken === true
  const ask = new Map([[1, protocol.version], [2, scoped ? SUB.pinTokenWithPermissions : SUB.pinToken], [3, platformKey], [6, pinProtocol.pinHashEnc(protocol, secret, pin)]])
  // A key that can scope its token gets the narrowest one: this one act, for this one relying party.
  if (scoped) { ask.set(9, permission); ask.set(10, rpId) }
  const m = await say(ch, COMMAND.clientPin, ask, { timeout: 5000 })
  return protocol.decrypt(secret, m.get(2))
}

const descriptor = (c) => new Map([['id', c.id], ['type', 'public-key']])

async function makeCredential (ch, protocol, token, r, opts) {
  const p = new Map([[1, r.clientDataHash], [2, r.rp], [3, r.user], [4, r.params.map(a => new Map([['alg', a.alg], ['type', a.type]]))]])
  if (r.exclude.length) p.set(5, r.exclude.map(descriptor))
  if (r.residentKey) p.set(7, { rk: true })
  p.set(8, protocol.authenticate(token, r.clientDataHash)); p.set(9, protocol.version)
  const m = await say(ch, COMMAND.makeCredential, p, opts)
  return { fmt: m.get(1), authData: m.get(2), attStmt: m.get(3) }
}

async function getAssertion (ch, protocol, token, r, opts) {
  const p = new Map([[1, r.rpId], [2, r.clientDataHash]])
  if (r.allow.length) p.set(3, r.allow.map(descriptor))
  if (token) { p.set(6, protocol.authenticate(token, r.clientDataHash)); p.set(7, protocol.version) }
  if (r.silent) p.set(5, { up: false })
  const m = await say(ch, COMMAND.getAssertion, p, opts)
  const user = m.get(4)
  return { credentialId: m.get(1) ? m.get(1).get('id') : (r.allow.length === 1 ? r.allow[0].id : null), authData: m.get(2), signature: m.get(3), userHandle: user ? user.get('id') : null }
}

/**
 * Wait for this key to be touched — how a person says «this one» when several are plugged in. It does not use the
 * PIN and costs no attempt: a key that knows the command for it (CTAP 2.1) gets that; an older one gets what the
 * standard gives instead (CTAP 2.0 §5.1, and what browsers and libfido2 send): a credential request with an empty
 * PIN proof, which the key answers, after the touch, with «PIN invalid» or «no PIN set» and no change to its counter.
 */
async function touched (ch, key, opts) {
  try {
    if (key.versions.includes('FIDO_2_1')) { await say(ch, COMMAND.selection, undefined, opts); return true }
    await say(ch, COMMAND.makeCredential, new Map([[1, Buffer.alloc(32)], [2, { id: '.dummy' }], [3, { id: Buffer.from([1]), name: 'dummy' }], [4, [new Map([['alg', -7], ['type', 'public-key']])]], [8, Buffer.alloc(0)], [9, 1]]), opts)
    return true
  } catch (e) {
    if (e instanceof KeyError && (e.status === STATUS.PIN_INVALID || e.status === STATUS.PIN_NOT_SET || e.status === STATUS.PIN_AUTH_INVALID)) return true
    if (e instanceof KeyError && (e.status === STATUS.KEEPALIVE_CANCEL || e.status === STATUS.USER_ACTION_TIMEOUT || e.status === STATUS.OPERATION_DENIED)) return false
    throw e
  }
}

module.exports = { info, retries, pinToken, makeCredential, getAssertion, touched, KeyError, STATUS, PERMISSION, COMMAND, SUB }
