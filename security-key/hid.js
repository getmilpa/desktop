// The wire to a security key: CTAPHID (FIDO CTAP 2.1 §11.2) — 64-byte reports on a channel the key hands out — and
// where the keys are on this machine.
//
// LINUX ONLY, AND NOTHING NATIVE. On Linux a USB security key is a `hidraw` device that the person at the seat may
// open (systemd's uaccess rule for security tokens — the same door a browser uses), and a hidraw device is a file:
// a report is one write, one read. So there is no native module to build or to trust. macOS has no such file; there
// `keys()` finds nothing and the window behaves as it did (greenhouse decisions/0568).
//
// (c) Rodrigo Vicente - TeamX Agency — Apache-2.0
'use strict'
const fs = require('node:fs')
const net = require('node:net')
const path = require('node:path')
const crypto = require('node:crypto')

const REPORT = 64
const CMD = { PING: 0x01, INIT: 0x06, CBOR: 0x10, CANCEL: 0x11, KEEPALIVE: 0x3b, ERROR: 0x3f }
const CAP_CBOR = 0x04
const BROADCAST = 0xffffffff
const KEEPALIVE = { PROCESSING: 1, TOUCH: 2 }

// ── transports: something that writes one report and reads the next ──────────────────────────────────────────────
// A hidraw file, opened non-blocking and asked every few milliseconds: a blocking read would hold one of Node's four
// file threads for as long as a key waits for a touch, and several keys wait at once.
function hidraw (file) {
  const fd = fs.openSync(file, fs.constants.O_RDWR | fs.constants.O_NONBLOCK)
  let closed = false
  return {
    // A report with no report id is written with a zero in front of it (Linux hidraw).
    // A closed device is never written to: its number may already be another file's.
    write: async (report) => { if (closed) throw new Error('closed'); fs.writeSync(fd, Buffer.concat([Buffer.from([0]), report])) },
    read: (deadline) => new Promise((resolve, reject) => {
      const buf = Buffer.alloc(REPORT)
      const once = () => {
        if (closed) return reject(new Error('closed'))
        let n = 0
        try { n = fs.readSync(fd, buf, 0, REPORT, null) } catch (e) { if (e.code !== 'EAGAIN') return reject(e) }
        if (n === REPORT) return resolve(buf)
        if (Date.now() > deadline) return reject(new Error('the key did not answer in time'))
        setTimeout(once, 4)
      }
      once()
    }),
    close: () => { if (!closed) { closed = true; try { fs.closeSync(fd) } catch {} } },
  }
}

// A stream that carries the same 64-byte reports — a key that is a process, not a device: the one the tests and the
// lab run against, so that no measurement opens a person's real key.
function socket (file) {
  const sock = net.connect(file)
  let pending = Buffer.alloc(0); let waiting = null; let failed = null
  const feed = () => { if (waiting && pending.length >= REPORT) { const r = pending.subarray(0, REPORT); pending = pending.subarray(REPORT); const w = waiting; waiting = null; clearTimeout(w.timer); w.resolve(Buffer.from(r)) } }
  sock.on('data', (d) => { pending = Buffer.concat([pending, d]); feed() })
  const fail = (e) => { failed = e || new Error('closed'); if (waiting) { const w = waiting; waiting = null; clearTimeout(w.timer); w.reject(failed) } }
  sock.on('error', fail); sock.on('close', () => fail())
  const ready = new Promise((resolve, reject) => { sock.once('connect', resolve); sock.once('error', reject) })
  return {
    // Resolved when the report has left: what is written just before closing — a CANCEL — is not lost with the socket.
    write: async (report) => { await ready; await new Promise((resolve, reject) => sock.write(report, (e) => (e ? reject(e) : resolve()))) },
    read: (deadline) => new Promise((resolve, reject) => {
      if (failed) return reject(failed)
      waiting = { resolve, reject, timer: setTimeout(() => { waiting = null; reject(new Error('the key did not answer in time')) }, Math.max(0, deadline - Date.now())) }
      feed()
    }),
    // Ended, not torn down: a socket destroyed with reports still unread resets the connection, and what was just
    // written to it — a CANCEL — can be thrown away on the other side.
    close: () => { try { sock.end(); setTimeout(() => sock.destroy(), 500).unref() } catch {} },
  }
}

// ── where the keys are ───────────────────────────────────────────────────────────────────────────────────────────
// Whether a HID report descriptor declares the FIDO usage page (0xF1D0) — what makes a hidraw device a security key
// rather than a keyboard. A YubiKey shows up as both; only this one is opened.
function isFido (descriptor) {
  for (let i = 0; i < descriptor.length;) {
    const b = descriptor[i]
    if (b === 0xfe) { i += 3 + (descriptor[i + 1] || 0); continue }   // a long item: skipped
    const size = (b & 3) === 3 ? 4 : (b & 3)
    if ((b & 0xfc) === 0x04) {   // global item: usage page
      let v = 0; for (let k = 0; k < size; k++) v |= (descriptor[i + 1 + k] || 0) << (8 * k)
      return v === 0xf1d0
    }
    i += 1 + size
  }
  return false
}

/**
 * The security keys plugged into this machine: `[{ path, name, open() }]`.
 *
 * MILPA_SECURITY_KEYS NAMES THEM INSTEAD (comma-separated paths — a hidraw device or a socket): then nothing is
 * looked for, and no other device is opened. A lab names its software key this way, with a person's real keys plugged
 * into the same machine and never touched.
 */
function keys ({ env = process.env, platform = process.platform, sys = '/sys/class/hidraw', dev = '/dev' } = {}) {
  const named = env.MILPA_SECURITY_KEYS
  if (typeof named === 'string') {
    return named.split(',').map(s => s.trim()).filter(Boolean).map((file) => {
      let isSocket = false
      try { isSocket = fs.statSync(file).isSocket() } catch { return null }
      return { path: file, name: path.basename(file), open: () => (isSocket ? socket(file) : hidraw(file)) }
    }).filter(Boolean)
  }
  if (platform !== 'linux') return []
  let nodes = []
  try { nodes = fs.readdirSync(sys).filter(n => /^hidraw\d+$/.test(n)) } catch { return [] }
  const found = []
  for (const node of nodes.sort((a, b) => Number(a.slice(6)) - Number(b.slice(6)))) {
    try {
      if (!isFido(fs.readFileSync(path.join(sys, node, 'device', 'report_descriptor')))) continue
      let name = node
      try { name = (fs.readFileSync(path.join(sys, node, 'device', 'uevent'), 'utf8').match(/^HID_NAME=(.+)$/m) || [])[1] || node } catch {}
      const file = path.join(dev, node)
      found.push({ path: file, name: name.trim(), open: () => hidraw(file) })
    } catch {}
  }
  return found
}

// ── a channel on one key ─────────────────────────────────────────────────────────────────────────────────────────
function frames (cid, cmd, payload) {
  const out = []
  const first = Buffer.alloc(REPORT)
  first.writeUInt32BE(cid, 0); first[4] = 0x80 | cmd; first.writeUInt16BE(payload.length, 5)
  payload.copy(first, 7, 0, REPORT - 7)
  out.push(first)
  let seq = 0
  for (let at = REPORT - 7; at < payload.length; at += REPORT - 5) {
    const next = Buffer.alloc(REPORT)
    next.writeUInt32BE(cid, 0); next[4] = seq++
    payload.copy(next, 5, at, at + REPORT - 5)
    out.push(next)
  }
  return out
}

class HidError extends Error { constructor (code) { super('the key refused the message (CTAPHID error 0x' + code.toString(16) + ')'); this.hid = code } }

/**
 * Open a channel: `{ cbor(payload, { onKeepalive, timeout }), cancel(), close(), canCbor }`.
 * One message at a time on a channel; `cancel()` is the one thing that may be sent while a message waits.
 */
async function channel (transport, { timeout = 3000 } = {}) {
  let cid = BROADCAST
  // One message's answer on this channel. Reports for other channels are another program's conversation with the
  // same key, and are let pass.
  const receive = async (cmd, deadline, onKeepalive) => {
    for (;;) {
      const first = await transport.read(deadline)
      if (first.readUInt32BE(0) !== cid || !(first[4] & 0x80)) continue
      const got = first[4] & 0x7f
      const length = first.readUInt16BE(5)
      const chunks = [first.subarray(7, 7 + Math.min(length, REPORT - 7))]
      let have = chunks[0].length; let seq = 0
      while (have < length) {
        const next = await transport.read(deadline)
        if (next.readUInt32BE(0) !== cid) continue
        if (next[4] !== seq++) throw new Error('the key sent its answer out of order')
        const part = next.subarray(5, 5 + Math.min(length - have, REPORT - 5))
        chunks.push(part); have += part.length
      }
      const payload = Buffer.concat(chunks)
      if (got === CMD.KEEPALIVE) { if (onKeepalive) onKeepalive(payload[0]); continue }
      if (got === CMD.ERROR) throw new HidError(payload[0])
      if (got !== cmd) continue
      return payload
    }
  }
  const send = async (cmd, payload) => { for (const f of frames(cid, cmd, payload)) await transport.write(f) }

  const nonce = crypto.randomBytes(8)
  await send(CMD.INIT, nonce)
  const deadline = Date.now() + timeout
  let init
  for (;;) { init = await receive(CMD.INIT, deadline); if (init.length >= 17 && init.subarray(0, 8).equals(nonce)) break }
  cid = init.readUInt32BE(8)
  const canCbor = !!(init[16] & CAP_CBOR)

  return {
    canCbor,
    cbor: async (payload, { onKeepalive, timeout: wait = 30000 } = {}) => { await send(CMD.CBOR, payload); return receive(CMD.CBOR, Date.now() + wait, onKeepalive) },
    cancel: async () => { try { await send(CMD.CANCEL, Buffer.alloc(0)) } catch {} },
    close: () => transport.close(),
  }
}

module.exports = { keys, channel, isFido, frames, HidError, KEEPALIVE, CMD, REPORT }
