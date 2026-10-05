// How a PIN travels to a security key (FIDO CTAP 2.1 §6.5.5–6.5.7, PIN/UV auth protocols one and two).
//
// THE PIN IS NEVER SENT, NOT EVEN ENCRYPTED. What goes to the key is the first half of its SHA-256, encrypted under a
// secret this process and the key agree on for one exchange (ECDH over P-256). What comes back is a token, encrypted
// the same way, that proves to the key — for this one ceremony — that whoever asked knew the PIN.
//
// A MISTAKE HERE COSTS THE PERSON AN ATTEMPT: a secret derived wrong makes the right PIN read as a wrong one, and a key
// allows eight before it must be reset. So every function below is compared, byte for byte, with Yubico's
// python-fido2 over the same inputs (test/pin-vectors.json), and that is why the private key and the IV can be handed
// in: a test does; nothing else may.
//
// (c) Rodrigo Vicente - TeamX Agency — Apache-2.0
'use strict'
const crypto = require('node:crypto')

const ZERO_IV = Buffer.alloc(16)
const aes = (make, key, iv, data) => { const c = make('aes-256-cbc', key, iv); c.setAutoPadding(false); return Buffer.concat([c.update(data), c.final()]) }
const hmac = (key, message) => crypto.createHmac('sha256', key).update(message).digest()

// The x coordinate of the point both sides reach, and this side's public key as the key reads it (COSE, EC2, P-256).
function agree (peerCoseKey, privateKey) {
  const x = peerCoseKey.get(-2); const y = peerCoseKey.get(-3)
  if (!Buffer.isBuffer(x) || !Buffer.isBuffer(y) || x.length !== 32 || y.length !== 32) throw new Error('the key sent a public key this does not read')
  const ecdh = crypto.createECDH('prime256v1')
  if (privateKey) ecdh.setPrivateKey(privateKey); else ecdh.generateKeys()
  const z = ecdh.computeSecret(Buffer.concat([Buffer.from([4]), x, y]))
  const pub = ecdh.getPublicKey()
  const platformKey = new Map([[1, 2], [3, -25], [-1, 1], [-2, pub.subarray(1, 33)], [-3, pub.subarray(33, 65)]])
  return { z, platformKey }
}

const ONE = {
  version: 1,
  kdf: (z) => crypto.createHash('sha256').update(z).digest(),
  encrypt: (secret, plaintext) => aes(crypto.createCipheriv, secret, ZERO_IV, plaintext),
  decrypt: (secret, ciphertext) => aes(crypto.createDecipheriv, secret, ZERO_IV, ciphertext),
  authenticate: (key, message) => hmac(key, message).subarray(0, 16),
}

const hkdf = (z, info) => Buffer.from(crypto.hkdfSync('sha256', z, Buffer.alloc(32), info, 32))
const TWO = {
  version: 2,
  // 64 bytes: the first half authenticates, the second encrypts.
  kdf: (z) => Buffer.concat([hkdf(z, 'CTAP2 HMAC key'), hkdf(z, 'CTAP2 AES key')]),
  encrypt: (secret, plaintext, iv) => { const v = iv || crypto.randomBytes(16); return Buffer.concat([v, aes(crypto.createCipheriv, secret.subarray(32), v, plaintext)]) },
  decrypt: (secret, ciphertext) => aes(crypto.createDecipheriv, secret.subarray(32), ciphertext.subarray(0, 16), ciphertext.subarray(16)),
  authenticate: (key, message) => hmac(key.subarray(0, 32), message),
}

const PROTOCOLS = { 1: ONE, 2: TWO }

/** The first protocol the key lists that this speaks — the key lists them in the order it prefers. */
function choose (offered) {
  for (const v of (Array.isArray(offered) && offered.length ? offered : [1])) if (PROTOCOLS[v]) return PROTOCOLS[v]
  return null
}

/** One exchange with the key: the shared secret, and this side's public key to send along. */
function encapsulate (protocol, peerCoseKey, { privateKey } = {}) {
  const { z, platformKey } = agree(peerCoseKey, privateKey)
  return { secret: protocol.kdf(z), platformKey }
}

/** What stands for the PIN on the wire: the left half of its SHA-256, encrypted. The PIN is normalized first (NFC). */
function pinHashEnc (protocol, secret, pin, { iv } = {}) {
  const hash = crypto.createHash('sha256').update(Buffer.from(String(pin).normalize('NFC'), 'utf8')).digest().subarray(0, 16)
  return protocol.encrypt(secret, hash, iv)
}

/**
 * Whether a PIN can be one at all, judged here so that a slip of the hand never reaches the key and costs an attempt
 * (CTAP 2.1 §6.5.1: at least `min` code points — four unless the key says more — and at most 63 bytes).
 */
function shape (pin, min = 4) {
  const p = String(pin == null ? '' : pin).normalize('NFC')
  if ([...p].length < Math.max(4, min || 4)) return 'too-short'
  if (Buffer.byteLength(p, 'utf8') > 63) return 'too-long'
  return null
}

module.exports = { PROTOCOLS, choose, encapsulate, pinHashEnc, shape }
