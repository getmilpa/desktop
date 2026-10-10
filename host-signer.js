// THE HOST SIGNER (greenhouse decisions/0611, decided by Rod 2026-10-10, option b).
//
// A contained house holds no private signing key (GHSA-fjwx-8j4j-cqfq). When it needs a `--sign` signature its
// RemoteOperationSigner (milpa/app-runtime) asks HERE, over a unix socket the Desktop bound into the container. This
// module — run in the Electron MAIN, where the person is — builds the canonical the house will verify, SHOWS the
// person exactly that, signs only on their approval with a key that never leaves the host, and answers. The approval
// is injected (`approve`), so the main shows it in a window out of the house page's reach; a test injects its own.
//
// The socket contract (v1) is milpa/app-runtime's RemoteOperationSigner docblock:
//   request  {"version":1,"operation":<string>,"arguments":<object>,"host":<string>}   (no timestamp: the HOST stamps it)
//   response {"version":1,"ok":true,"payload":<canonical string>,"signature":<armored>}  or  {"version":1,"ok":false,"why":<string>}

'use strict'

const net = require('node:net')
const os = require('node:os')
const fs = require('node:fs')
const path = require('node:path')
const crypto = require('node:crypto')
const { execFile } = require('node:child_process')

const PROTOCOL_VERSION = 1

// The bytes the house verifies and re-canonicalizes (milpa/tool-runtime OperationAuthorization::canonical): every map
// sorted at every depth, the top level alphabetical, unescaped unicode and slashes — which JSON.stringify already is.
// The house re-sorts and re-encodes both sides, so this need not be byte-identical with PHP; keeping it the same shape
// keeps the bytes the person approves legible and close to what the house rebuilds.
function canonical (operation, args, host, issuedAt, nonce) {
  const sortDeep = (v) => {
    if (Array.isArray(v)) return v.map(sortDeep)
    if (v && typeof v === 'object') {
      const o = {}
      for (const k of Object.keys(v).sort()) o[k] = sortDeep(v[k])
      return o
    }
    return v
  }
  return JSON.stringify({ arguments: sortDeep(args || {}), host, issuedAt, nonce, operation })
}

// gpg detaches a signature over the canonical, from the GNUPGHOME given (the person's key, on the host). No --batch:
// a card touch or passphrase must be able to reach the person.
function detachSign (payload, gnupgHome, gpgBinary = 'gpg') {
  return new Promise((resolve) => {
    const file = path.join(os.tmpdir(), 'milpa-host-authz-' + crypto.randomBytes(8).toString('hex'))
    try { fs.writeFileSync(file, payload) } catch { return resolve(null) }
    execFile(gpgBinary, ['--armor', '--detach-sign', '--output', '-', file], { env: { ...process.env, GNUPGHOME: gnupgHome }, maxBuffer: 1 << 20 }, (err, stdout) => {
      try { fs.unlinkSync(file) } catch {}
      resolve(!err && typeof stdout === 'string' && stdout.includes('BEGIN PGP SIGNATURE') ? stdout : null)
    })
  })
}

// Start the host signer on `socketPath`. `approve(authorization)` resolves true to sign, false/throw to refuse — the
// authorization it is given (operation, arguments, host, issuedAt, nonce, and `canonical`: the exact bytes to be
// signed) is EXACTLY what gets signed, so what the person sees is what they sign. `gnupgHome` holds the person's
// private key. Returns the net.Server.
function serve ({ socketPath, gnupgHome, approve, gpgBinary = 'gpg' }) {
  try { fs.unlinkSync(socketPath) } catch {}
  const server = net.createServer((conn) => {
    let buf = ''
    let done = false
    const reply = (obj) => { if (done) return; done = true; try { conn.write(JSON.stringify(obj) + '\n') } catch {} try { conn.end() } catch {} }
    conn.setEncoding('utf8')
    conn.on('data', async (chunk) => {
      buf += chunk
      const nl = buf.indexOf('\n')
      if (nl < 0 || done) return
      let req
      try { req = JSON.parse(buf.slice(0, nl)) } catch { return reply({ version: PROTOCOL_VERSION, ok: false, why: 'the request could not be read' }) }
      if (req.version !== PROTOCOL_VERSION) return reply({ version: PROTOCOL_VERSION, ok: false, why: 'unsupported protocol version' })

      // The HOST stamps issuedAt (its own clock) and the nonce — never the house's `now` (0611).
      const authorization = {
        operation: String(req.operation),
        arguments: (req.arguments && typeof req.arguments === 'object') ? req.arguments : {},
        host: String(req.host),
        issuedAt: new Date().toISOString(),
        nonce: crypto.randomBytes(16).toString('hex')
      }

      // The person approves the EXACT bytes that get signed: build the canonical once, show THAT, sign THAT. What the
      // approval window renders is `payload` itself — never a description the house sent alongside (0611, point 1).
      const payload = canonical(authorization.operation, authorization.arguments, authorization.host, authorization.issuedAt, authorization.nonce)
      let approved = false
      try { approved = (await approve({ ...authorization, canonical: payload })) === true } catch { approved = false }
      if (!approved) return reply({ version: PROTOCOL_VERSION, ok: false, why: 'the person did not approve it' })

      const signature = await detachSign(payload, gnupgHome, gpgBinary)
      if (signature === null) return reply({ version: PROTOCOL_VERSION, ok: false, why: 'the key on this host did not sign' })
      reply({ version: PROTOCOL_VERSION, ok: true, payload, signature })
    })
    conn.on('error', () => reply({ version: PROTOCOL_VERSION, ok: false, why: 'the connection failed' }))
  })
  server.listen(socketPath)
  return server
}

module.exports = { serve, canonical, detachSign, PROTOCOL_VERSION }
