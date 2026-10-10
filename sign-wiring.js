// How a contained house is wired to sign through the host (greenhouse decisions/0611, (b)). One place for the three
// facts that main.js and the measurement must agree on: where the host signer's socket is mounted, the env that tells
// the house to sign through it, and how the container is left with PUBLIC keys only. There is NO keyring mount and NO
// pcscd mount here — that is the whole point: the private key never enters the container.
'use strict'

const path = require('node:path')
const { execFileSync } = require('node:child_process')

const SOCKET_BASENAME = 'sign.sock'
const CONTAINER_SOCKET_DIR = '/run/milpa'
const CONTAINER_SOCKET = CONTAINER_SOCKET_DIR + '/' + SOCKET_BASENAME

// The host path the signer binds (kept short so the unix socket path stays under the ~107-byte limit).
function hostSocketPath (socketDir) { return path.join(socketDir, SOCKET_BASENAME) }

// The `docker run` additions for 0611: mount the socket's DIR in (the socket appears inside it once the host binds),
// and set MILPA_SIGN_SOCKET so the house's RemoteOperationSigner asks the host instead of signing locally. The dir is
// mounted (not the socket file) so the target need not pre-exist; the signer may bind after the container starts.
function containerSignArgs (socketDir) {
  return ['-v', `${socketDir}:${CONTAINER_SOCKET_DIR}`, '-e', `MILPA_SIGN_SOCKET=${CONTAINER_SOCKET}`]
}

// After the house is up, give the container ONLY the public key(s) it needs to VERIFY — exported from the host keyring,
// imported into the container's own (unmounted) keyring. The private key stays on the host. Returns how many SECRET
// keys remain in the container (must be 0) and whether a public key was provisioned. Uses execFileSync throughout:
// gpg import reads the armored key on stdin, which async execFile cannot feed.
function provisionPublicKeyring ({ container, hostGnupg, gpg = 'gpg' }) {
  let pub = ''
  try {
    pub = execFileSync(gpg, ['--armor', '--export'], { env: { ...process.env, GNUPGHOME: hostGnupg }, encoding: 'utf8', maxBuffer: 1 << 24 })
  } catch { pub = '' }
  const hasPub = pub.includes('BEGIN PGP PUBLIC KEY')
  if (hasPub) {
    try { execFileSync('docker', ['exec', '-i', container, 'gpg', '--batch', '--import'], { input: pub, stdio: ['pipe', 'ignore', 'ignore'] }) } catch {}
  }
  // -1 means the check could not run — NOT "0 secrets". An empty result is not a fact (0611 review).
  let secret = -1
  try {
    const out = execFileSync('docker', ['exec', container, 'gpg', '--list-secret-keys', '--with-colons'], { encoding: 'utf8' })
    secret = (out || '').split('\n').filter((l) => l.startsWith('sec')).length
  } catch { secret = -1 }
  return { secret, provisioned: hasPub }
}

module.exports = { containerSignArgs, hostSocketPath, provisionPublicKeyring, CONTAINER_SOCKET, CONTAINER_SOCKET_DIR }
