// THE DESKTOP HOST SIGNER, MEASURED UNDER xvfb (greenhouse decisions/0611, (b); evidence/1183's Desktop side).
//
// It drives the REAL modules main.js uses — host-signer.js (the socket signer), host-approve.js (the approval window
// the main owns), sign-wiring.js (the docker-run wiring + public-keyring provisioning) — against a REAL lab container
// running the REAL app-runtime #789 RemoteOperationSigner, over a REAL unix socket, with a LAB key. The person's
// private key is on the host ONLY; the container holds the public key only. It measures the coordinator's six points
// (its reading of (b)) and the three controls.
//
// SAFETY (coordinator, verbatim): lab keys with disable-scdaemon; NEVER Rod's keyring, pcscd, real Desktop, or
// ~/.milpa; NEVER `gpg --card-status`. All keyrings are throwaway temp dirs; the container is --network none and named
// apart; nothing here reads the host card.
//
// Run by test/verify.sh under xvfb, or directly:
//   MILPA_APP_RUNTIME_SRC=<app-runtime worktree>/src xvfb-run -a electron --no-sandbox test/smoke-sign.js

'use strict'
const { app, BrowserWindow, ipcMain } = require('electron')
const { execFileSync, execFile } = require('node:child_process')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const ROOT = path.join(__dirname, '..')
const hostSigner = require(path.join(ROOT, 'host-signer.js'))
const signWiring = require(path.join(ROOT, 'sign-wiring.js'))
const { makeApprover } = require(path.join(ROOT, 'host-approve.js'))

app.commandLine.appendSwitch('no-sandbox'); app.commandLine.appendSwitch('disable-gpu'); app.disableHardwareAcceleration()
// This smoke opens and closes approval windows; without a persistent main window, the LAST approval window closing
// would drop the window count to 0 and Electron would auto-quit mid-measure. The smoke owns its own exit (app.exit).
app.on('window-all-closed', () => {})

const IMG = process.env.MILPA_LAB_IMAGE || 'ghcr.io/getmilpa/framework:dev'
// Optional: overlay a local app-runtime src into the container. Needed only UNTIL the framework image ships
// app-runtime #789 (RemoteOperationSigner); after that a stock image carries it and no overlay is required.
const APP_RUNTIME_SRC = process.env.MILPA_APP_RUNTIME_SRC || ''
const NAME = 'milpa-0611-measure'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts })
const dockerExec = (args, opts = {}) => { try { return sh('docker', ['exec', NAME, ...args], opts) } catch (e) { return String((e && e.stdout) || (e && e.message) || e) } }
// A signing probe MUST run async: it round-trips to the host signer, whose approval window needs this same event loop
// to run. A blocking execFileSync would freeze the loop and the approval could never answer. Returns the probe's JSON.
const dockerProbe = (fpr) => new Promise((resolve) => {
  execFile('docker', ['exec', NAME, 'php', '/labtest/sign-probe.php', fpr], { encoding: 'utf8', maxBuffer: 1 << 24 }, (err, out) => {
    try { resolve(JSON.parse(((out || '').trim().split('\n').filter(Boolean).pop()) || '{}')) } catch { resolve({ parseError: true, raw: (out || String(err)).slice(-300) }) }
  })
})

const checks = []
function record (name, ok, detail) { checks.push({ ok: !!ok }); console.log((ok ? 'PASS' : 'FAIL') + ' · ' + name + (ok || !detail ? '' : ' — ' + detail)) }

// find the approval window the main just opened (host-approve.js), by its title
function approvalWindow () { return BrowserWindow.getAllWindows().find((w) => { try { return !w.isDestroyed() && w.getTitle() === 'Approve a signature' } catch { return false } }) }

app.whenReady().then(async () => {
  const W = fs.mkdtempSync(path.join(os.tmpdir(), 'ms0611.')) // short base so the socket path stays < 107 bytes
  const HOST = path.join(W, 'host')   // the person's keyring (private key), host-side
  const SEAT = path.join(W, 'seat')   // the seat's keyring, its OWN, apart from the person's (0611)
  const SOCKDIR = path.join(W, 's')   // mounted into the container as /run/milpa
  let server = null
  let FPR = ''

  try {
    // ── 0. lab keyrings + a lab person key (ed25519, no passphrase, no scdaemon) ──────────────────────
    for (const d of [HOST, SEAT, SOCKDIR]) fs.mkdirSync(d, { recursive: true, mode: 0o700 })
    for (const d of [HOST, SEAT]) fs.writeFileSync(path.join(d, 'gpg-agent.conf'), 'disable-scdaemon\n')
    const params = '%no-protection\nKey-Type: eddsa\nKey-Curve: ed25519\nKey-Usage: sign\nName-Real: Lab Person\nName-Email: person@lab.local\nExpire-Date: 0\n%commit\n'
    sh('gpg', ['--batch', '--pinentry-mode', 'loopback', '--gen-key'], { input: params, env: { ...process.env, GNUPGHOME: HOST }, stdio: ['pipe', 'ignore', 'ignore'] })
    const hostSec = sh('gpg', ['--list-secret-keys', '--with-colons'], { env: { ...process.env, GNUPGHOME: HOST } })
    FPR = (hostSec.split('\n').find((l) => l.startsWith('fpr')) || '').split(':')[9] || ''
    const hostSecretCount = hostSec.split('\n').filter((l) => l.startsWith('sec')).length
    const seatSecretCount = (() => { try { return sh('gpg', ['--list-secret-keys', '--with-colons'], { env: { ...process.env, GNUPGHOME: SEAT } }).split('\n').filter((l) => l.startsWith('sec')).length } catch { return 0 } })()
    record('the person\'s private key is on the HOST (1 secret), the seat keyring is a SEPARATE host keyring', hostSecretCount === 1 && FPR !== '' && SEAT !== HOST && seatSecretCount === 0, `host=${hostSecretCount} seat=${seatSecretCount}`)

    // ── 1. the host signer, bound on the socket, with the REAL approval window ─────────────────────────
    const socketPath = signWiring.hostSocketPath(SOCKDIR)
    const approve = makeApprover({ app, BrowserWindow, ipcMain, root: ROOT, parent: null })
    delete process.env.MILPA_SIGN_AUTODECIDE // the next approval is driven by hand, to inspect the window
    server = hostSigner.serve({ socketPath, gnupgHome: HOST, approve })
    await new Promise((r) => server.once('listening', r))

    // ── POINT 1 (what is shown IS what is signed) + POINT 2 (approval out of the page's reach) ─────────
    // Call the approver directly so we can read what the window shows and prove who may answer it.
    const issuedAt = new Date().toISOString(); const nonce = 'deadbeefdeadbeefdeadbeefdeadbeef'
    const authz = { operation: 'capabilities:enable', arguments: { capability: 'milpa/admin' }, host: 'labhouse', issuedAt, nonce }
    authz.canonical = hostSigner.canonical(authz.operation, authz.arguments, authz.host, authz.issuedAt, authz.nonce)
    const pending = approve(authz)
    let aw = null
    for (let i = 0; i < 50 && !aw; i++) { aw = approvalWindow(); if (!aw) await sleep(100) }
    record('the approval opens in a window the MAIN owns, separate from any page', !!aw)
    if (aw) {
      await aw.webContents.executeJavaScript('new Promise(r=>{if(document.readyState==="complete")r();else window.addEventListener("load",r)})').catch(() => {})
      const shown = await aw.webContents.executeJavaScript('({ op: window.approval.data().operation, canonical: window.approval.data().canonical, opText: document.querySelector("#op").textContent, canonText: document.querySelector("#canonical").textContent })').catch((e) => ({ err: String(e) }))
      record('POINT 1 · the window shows exactly the canonical the host will sign (operation + bytes)', shown.op === authz.operation && shown.canonical === authz.canonical && shown.opText === authz.operation && shown.canonText === authz.canonical, JSON.stringify(shown).slice(0, 200))

      // POINT 2 · a renderer that is NOT the approval window — what a page the house serves would be — cannot answer,
      // even holding a leaked token.
      const attacker = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'sign-attacker-preload.js'), contextIsolation: true, sandbox: false } })
      await attacker.loadURL('about:blank')
      await attacker.webContents.executeJavaScript("window.attack.decide('deadbeefdeadbeefdeadbeefdeadbeef', true)").catch(() => {})
      await sleep(400)
      const stillOpen = !!approvalWindow()
      record('POINT 2 · another renderer cannot answer the approval (the pending sign is still unanswered)', stillOpen)
      try { attacker.close() } catch {}

      // the real window's own button resolves it
      await aw.webContents.executeJavaScript('document.querySelector("#approve").click()').catch(() => {})
    }
    const approvedDirect = await Promise.race([pending, sleep(5000).then(() => 'timeout')])
    record('POINT 2 · only the approval window\'s own button approves it', approvedDirect === true, String(approvedDirect))

    // POINT 2 · the house page's bridge exposes nothing that could answer or reach the approval
    const housePage = new BrowserWindow({ show: false, webPreferences: { preload: path.join(ROOT, 'preload.js'), additionalArguments: ['--milpa-house=http://localhost:8899'], contextIsolation: true, sandbox: false } })
    await housePage.loadURL('about:blank') // a file:// page: the fullest bridge preload.js ever grants
    const bridge = await housePage.webContents.executeJavaScript('({ keys: Object.keys(window.milpa||{}), hasRequire: typeof window.require, sign: Object.keys(window.milpa||{}).filter(k=>/approv|sign/i.test(k)) })').catch((e) => ({ err: String(e) }))
    record('POINT 2 · the house bridge has no approval/sign-approval method, and no node in the page', Array.isArray(bridge.keys) && bridge.sign.length === 0 && bridge.hasRequire === 'undefined', JSON.stringify(bridge).slice(0, 200))
    try { housePage.close() } catch {}

    // ── 2. the lab container, wired by the REAL sign-wiring — NO keyring/pcscd mount ───────────────────
    const overlay = (APP_RUNTIME_SRC && fs.existsSync(APP_RUNTIME_SRC)) ? ['-v', `${APP_RUNTIME_SRC}:/app/vendor/milpa/app-runtime/src:ro`] : []
    const imageId = (() => { try { return sh('docker', ['image', 'inspect', '--format', '{{.Id}}', IMG]).trim() } catch { return IMG } })()
    console.log(`# image=${IMG} id=${imageId} app-runtime-overlay=${overlay.length ? APP_RUNTIME_SRC : '(none — stock image)'}`)
    try { sh('docker', ['rm', '-f', NAME], { stdio: ['ignore', 'ignore', 'ignore'] }) } catch {}
    sh('docker', ['run', '-d', '--name', NAME, '--network', 'none',
      ...overlay,
      '-v', `${__dirname}:/labtest:ro`,
      ...signWiring.containerSignArgs(SOCKDIR),
      '--entrypoint', 'sleep', IMG, 'infinity'])
    const prov = signWiring.provisionPublicKeyring({ container: NAME, hostGnupg: HOST })

    // ── POINT 5 (the container: public keys only, seat key apart, mounts gone) ────────────────────────
    const mounts = sh('docker', ['inspect', '--format', '{{json .Mounts}}', NAME])
    const envJson = sh('docker', ['inspect', '--format', '{{json .Config.Env}}', NAME])
    record('POINT 5 · no host keyring (/root/.gnupg) is mounted into the container', !/\/root\/\.gnupg/.test(mounts), mounts.slice(0, 200))
    record('POINT 5 · no /run/pcscd is mounted into the container', !/run\/pcscd/.test(mounts))
    record('POINT 5 · MILPA_SIGN_SOCKET is set — the house is told to sign through the host', /MILPA_SIGN_SOCKET=\/run\/milpa\/sign\.sock/.test(envJson))
    record('POINT 5 · the host signer\'s socket is present inside the container', /socket/i.test(dockerExec(['sh', '-c', 'test -S /run/milpa/sign.sock && echo socket || echo no'])))
    record('POINT 5 · the container holds PUBLIC keys only (0 secret keys)', prov.secret === 0 && prov.provisioned, `secret=${prov.secret} provisioned=${prov.provisioned}`)

    // ── POINT 1 + 3 + 6 (HAPPY): the REAL house asks over the socket, the host signs on approval, the house verifies ─
    process.env.MILPA_SIGN_AUTODECIDE = 'approve'
    const r1 = await dockerProbe(FPR)
    record('HAPPY · the house got a signature and verified it with its PUBLIC-only keyring', r1.signed === true && r1.verified === true && r1.fpr_matches === true && r1.container_secret_keys === 0, JSON.stringify(r1).slice(0, 220))
    record('POINT 1 · what was signed is the operation that was asked (end to end)', r1.operation === 'capabilities:enable' && r1.arguments && r1.arguments.capability === 'milpa/admin')
    record('POINT 3 · the HOST stamped the time and a nonce (not the house\'s clock)', r1.has_nonce === true && typeof r1.issuedAt === 'string' && /^\d{4}-\d\d-\d\dT/.test(r1.issuedAt || '') && r1.host === 'labhouse')
    const r2 = await dockerProbe(FPR)
    record('POINT 3 · a second request is approved and signed afresh — a fresh nonce, never "allow always"', r2.signed === true && r2.issuedAt !== r1.issuedAt)

    // ── POINT 4 (a NO is a refusal with its reason) ───────────────────────────────────────────────────
    process.env.MILPA_SIGN_AUTODECIDE = 'deny'
    const rd = await dockerProbe(FPR)
    record('POINT 4 · a refused approval comes back to the house as "not signed", with its reason', rd.signed === false && /did not approve/i.test(rd.reason || ''), JSON.stringify(rd))

    // ── POINT 6 (no host, no signature) ───────────────────────────────────────────────────────────────
    process.env.MILPA_SIGN_AUTODECIDE = 'approve'
    try { server.close() } catch {}
    try { fs.rmSync(socketPath, { force: true }) } catch {}
    server = null
    await sleep(300)
    const rn = await dockerProbe(FPR)
    record('POINT 6 · with no host answering, the house gets no signature, with its reason', rn.signed === false && /did not answer on its socket/i.test(rn.reason || ''), JSON.stringify(rn))
  } catch (e) {
    record('harness ran without throwing', false, String(e && e.stack || e))
  } finally {
    try { if (server) server.close() } catch {}
    try { sh('docker', ['rm', '-f', NAME], { stdio: ['ignore', 'ignore', 'ignore'] }) } catch {}
    try { fs.rmSync(W, { recursive: true, force: true }) } catch {}
  }

  const failed = checks.filter((c) => !c.ok).length
  console.log('\n' + (checks.length - failed) + '/' + checks.length + ' host-signer checks passed')
  app.exit(failed ? 1 : 0)
})
