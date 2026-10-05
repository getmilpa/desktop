// CBOR, as much of it as a security key speaks (CTAP2 canonical form, FIDO CTAP §8): integers, byte strings, text,
// arrays, maps and booleans. Maps are written with their keys sorted the way the key expects — by major type, then
// shorter first, then bytewise — and read back as a Map, because a key's maps are keyed by integers.
//
// (c) Rodrigo Vicente - TeamX Agency — Apache-2.0
'use strict'

function head (major, n) {
  const m = major << 5
  if (n < 24) return Buffer.from([m | n])
  if (n < 0x100) return Buffer.from([m | 24, n])
  if (n < 0x10000) { const b = Buffer.alloc(3); b[0] = m | 25; b.writeUInt16BE(n, 1); return b }
  if (n < 0x100000000) { const b = Buffer.alloc(5); b[0] = m | 26; b.writeUInt32BE(n, 1); return b }
  const b = Buffer.alloc(9); b[0] = m | 27; b.writeBigUInt64BE(BigInt(n), 1); return b
}

function encode (v) {
  if (v === true) return Buffer.from([0xf5])
  if (v === false) return Buffer.from([0xf4])
  if (typeof v === 'number') {
    if (!Number.isSafeInteger(v)) throw new TypeError('cbor: only integers are written')
    return v >= 0 ? head(0, v) : head(1, -1 - v)
  }
  if (typeof v === 'string') { const s = Buffer.from(v, 'utf8'); return Buffer.concat([head(3, s.length), s]) }
  if (Buffer.isBuffer(v) || v instanceof Uint8Array) return Buffer.concat([head(2, v.length), Buffer.from(v)])
  if (Array.isArray(v)) return Buffer.concat([head(4, v.length), ...v.map(encode)])
  if (v instanceof Map || (v && typeof v === 'object')) {
    const entries = (v instanceof Map ? [...v.entries()] : Object.entries(v)).filter(([, x]) => x !== undefined)
    const pairs = entries.map(([k, x]) => [encode(k), encode(x)])
    pairs.sort(([a], [b]) => (a[0] >> 5) - (b[0] >> 5) || a.length - b.length || Buffer.compare(a, b))
    return Buffer.concat([head(5, pairs.length), ...pairs.flat()])
  }
  throw new TypeError('cbor: cannot write ' + (v === null ? 'null' : typeof v))
}

// One item at `at`: [value, where the next one starts]. What a key never sends — tags, floats, indefinite lengths —
// is refused rather than guessed at.
function item (buf, at) {
  if (at >= buf.length) throw new RangeError('cbor: the message ends early')
  const major = buf[at] >> 5; const info = buf[at] & 31
  let n = info; let p = at + 1
  if (info === 24) { n = buf.readUInt8(p); p += 1 } else if (info === 25) { n = buf.readUInt16BE(p); p += 2 } else if (info === 26) { n = buf.readUInt32BE(p); p += 4 } else if (info === 27) {
    const big = buf.readBigUInt64BE(p); p += 8
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) throw new RangeError('cbor: an integer too large to read')
    n = Number(big)
  } else if (info > 27) throw new RangeError('cbor: a length this does not read')
  if (major === 0) return [n, p]
  if (major === 1) return [-1 - n, p]
  if (major === 2 || major === 3) {
    if (p + n > buf.length) throw new RangeError('cbor: the message ends early')
    const bytes = buf.subarray(p, p + n)
    return [major === 2 ? Buffer.from(bytes) : bytes.toString('utf8'), p + n]
  }
  if (major === 4) { const list = []; for (let i = 0; i < n; i++) { const [x, q] = item(buf, p); list.push(x); p = q } return [list, p] }
  if (major === 5) {
    const map = new Map()
    for (let i = 0; i < n; i++) { const [k, q] = item(buf, p); const [x, r] = item(buf, q); map.set(k, x); p = r }
    return [map, p]
  }
  if (major === 7 && (buf[at] === 0xf4 || buf[at] === 0xf5)) return [buf[at] === 0xf5, at + 1]
  if (major === 7 && buf[at] === 0xf6) return [null, at + 1]
  throw new RangeError('cbor: an item this does not read (0x' + buf[at].toString(16) + ')')
}

/** The one item the buffer holds; bytes after it are an error. */
function decode (buf) {
  const [v, end] = item(buf, 0)
  if (end !== buf.length) throw new RangeError('cbor: bytes after the message')
  return v
}

/** The first item, and how many bytes it took — a key's public key sits inside other bytes with more after it. */
function decodeFirst (buf) { const [value, length] = item(buf, 0); return { value, length } }

module.exports = { encode, decode, decodeFirst }
