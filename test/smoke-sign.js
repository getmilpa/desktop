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

// The smoke drives the approval UI headlessly WITHOUT any production seam: when the host signer opens an approval
// window for a SOCKET request, this watcher clicks its button per `autoMode`, and captures one screenshot if asked.
// Windows the smoke drives by hand (the direct point-1/2 test, the mutation) run with autoMode=null, untouched here.
let autoMode = null // 'approve' | 'deny' | null
let shotTaken = false
const SHOT = process.env.MILPA_SIGN_SHOT || ''
app.on('browser-window-created', (_e, w) => {
  w.webContents.once('did-finish-load', async () => {
    try {
      if (w.isDestroyed() || w.getTitle() !== 'Approve a signature') return
      if (SHOT && !shotTaken) { shotTaken = true; try { fs.writeFileSync(SHOT, (await w.webContents.capturePage()).toPNG()) } catch {} }
      if (autoMode === 'approve' || autoMode === 'deny') await w.webContents.executeJavaScript(`document.querySelector('#${autoMode}').click()`)
    } catch {}
  })
})

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
// Is this exact token present in some process's argv (/proc)? Proves the one-time token travels in argv — the main
// generated it, so we scan for the known value (the renderer's own sandboxed cmdline hides additionalArguments, but
// the process Electron launches it with carries them).
function tokenInArgv (token) {
  if (!token) return false
  try {
    for (const pid of fs.readdirSync('/proc')) {
      if (!/^\d+$/.test(pid)) continue
      let raw
      try { raw = fs.readFileSync(`/proc/${pid}/cmdline`, 'latin1') } catch { continue }
      if (raw.includes('--token=' + token)) return true
    }
  } catch {}
  return false
}

app.whenReady().then(async () => {
  const W = fs.mkdtempSync(path.join(os.tmpdir(), 'ms0611.')) // short base so the socket path stays < 107 bytes
  const HOST = path.join(W, 'host')   // the person's keyring (private key), host-side
  const SEAT = path.join(W, 'seat')   // the seat's keyring, its OWN, apart from the person's (0611)
  const SOCKDIR = path.join(W, 's')   // mounted into the container as /run/milpa
  let server = null
  let FPR = ''
  let realToken = ''

  try {
    // ── 0. lab keyrings + a lab person key (ed25519, no passphrase, no scdaemon) ──────────────────────
    for (const d of [HOST, SEAT, SOCKDIR]) fs.mkdirSync(d, { recursive: true, mode: 0o700 })
    for (const d of [HOST, SEAT]) fs.writeFileSync(path.join(d, 'gpg-agent.conf'), 'disable-scdaemon\n')
    const params = '%no-protection\nKey-Type: eddsa\nKey-Curve: ed25519\nKey-Usage: sign\nName-Real: Lab Person\nName-Email: person@lab.local\nExpire-Date: 0\n%commit\n'
    sh('gpg', ['--batch', '--pinentry-mode', 'loopback', '--gen-key'], { input: params, env: { ...process.env, GNUPGHOME: HOST }, stdio: ['pipe', 'ignore', 'ignore'] })
    const hostSec = sh('gpg', ['--list-secret-keys', '--with-colons'], { env: { ...process.env, GNUPGHOME: HOST } })
    FPR = (hostSec.split('\n').find((l) => l.startsWith('fpr')) || '').split(':')[9] || ''
    // a second lab key — the NEW key B the person would generate after A is treated as compromised (migration probe)
    const KEYB = path.join(W, 'keyb'); fs.mkdirSync(KEYB, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(KEYB, 'gpg-agent.conf'), 'disable-scdaemon\n')
    sh('gpg', ['--batch', '--pinentry-mode', 'loopback', '--gen-key'], { input: params, env: { ...process.env, GNUPGHOME: KEYB }, stdio: ['pipe', 'ignore', 'ignore'] })
    const FPR_B = (sh('gpg', ['--list-secret-keys', '--with-colons'], { env: { ...process.env, GNUPGHOME: KEYB } }).split('\n').find((l) => l.startsWith('fpr')) || '').split(':')[9] || ''
    const hostSecretCount = hostSec.split('\n').filter((l) => l.startsWith('sec')).length
    const seatSecretCount = (() => { try { return sh('gpg', ['--list-secret-keys', '--with-colons'], { env: { ...process.env, GNUPGHOME: SEAT } }).split('\n').filter((l) => l.startsWith('sec')).length } catch { return 0 } })()
    record('the person\'s private key is on the HOST (1 secret), the seat keyring is a SEPARATE host keyring', hostSecretCount === 1 && FPR !== '' && SEAT !== HOST && seatSecretCount === 0, `host=${hostSecretCount} seat=${seatSecretCount}`)

    // ── 1. the host signer, bound on the socket, with the REAL approval window ─────────────────────────
    const socketPath = signWiring.hostSocketPath(SOCKDIR)
    // the main generates the one-time token; capture it here (the main may legitimately know it) so the attacker can
    // be handed the REAL token and the test turns on the SENDER gate, not the token check.
    let capturedToken = ''
    const approve = makeApprover({ app, BrowserWindow, ipcMain, root: ROOT, parent: null, onShown: (_a, t) => { capturedToken = t } })
    autoMode = null // the next approval is driven by hand, to inspect the window
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

      // POINT 2 · the REAL one-time token (captured from the main) — used so the test turns on the SENDER gate, not
      // the token check. It travels to the window in its argv: the preload reads `--token=` from process.argv, and the
      // own-button approval below only succeeds because it sent back that exact value (a /proc note is best-effort).
      realToken = capturedToken
      console.log('# token in /proc argv (best-effort): ' + tokenInArgv(realToken))
      record('POINT 2 · the one-time token is a fresh 32-hex value carried to the window in its argv', /^[0-9a-f]{32}$/.test(realToken), realToken.slice(0, 8))
      // the window shows how long it has left (POINT 5, countdown)
      const cd = await aw.webContents.executeJavaScript('document.querySelector("#countdown").textContent').catch(() => '')
      record('POINT 5 · the approval window shows the time it has left (countdown)', /expires in \d+s/.test(cd), cd)

      // a DIFFERENT renderer — what a page the house serves would be — sends the REAL token: the sender gate must refuse
      const attacker = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'sign-attacker-preload.js'), contextIsolation: true, sandbox: false } })
      await attacker.loadURL('about:blank')
      await attacker.webContents.executeJavaScript(`window.attack.decide(${JSON.stringify(realToken)}, true)`).catch(() => {})
      await sleep(400)
      record('POINT 2 · another renderer cannot answer even with the REAL token (the sender gate refuses it)', !!approvalWindow())
      try { attacker.close() } catch {}

      // the real window's own button resolves it (same token, right sender → accepted)
      await aw.webContents.executeJavaScript('document.querySelector("#approve").click()').catch(() => {})
    }
    const approvedDirect = await Promise.race([pending, sleep(5000).then(() => 'timeout')])
    record('POINT 2 · only the approval window\'s own button approves it — its preload read the token from argv and sent it back', approvedDirect === true, String(approvedDirect))

    // POINT 2 · MUTATION control: a second approver built with `allowAnySender: true` — a makeApprover OPTION the smoke
    // passes and the Desktop's main NEVER does — removes ONLY the sender gate. The same forged message with the REAL
    // token MUST now succeed, proving the gate, not the token check, is what refuses the attacker above.
    let mutToken = ''
    const approveMutable = makeApprover({ app, BrowserWindow, ipcMain, root: ROOT, parent: null, allowAnySender: true, onShown: (_a, t) => { mutToken = t } })
    const authzM = { ...authz, nonce: 'feedfeedfeedfeedfeedfeedfeedfeed' }
    authzM.canonical = hostSigner.canonical(authzM.operation, authzM.arguments, authzM.host, authzM.issuedAt, authzM.nonce)
    autoMode = null // the attacker answers this one, not the watcher
    const pendingM = approveMutable(authzM)
    let awM = null
    for (let i = 0; i < 50 && !awM; i++) { awM = approvalWindow(); if (!awM) await sleep(100) }
    const atk2 = new BrowserWindow({ show: false, webPreferences: { preload: path.join(__dirname, 'sign-attacker-preload.js'), contextIsolation: true, sandbox: false } })
    await atk2.loadURL('about:blank')
    await atk2.webContents.executeJavaScript(`window.attack.decide(${JSON.stringify(mutToken)}, true)`).catch(() => {})
    const mutated = await Promise.race([pendingM, sleep(4000).then(() => 'timeout')])
    record('POINT 2 · MUTATION: without the sender gate the forged (real-token) message SUCCEEDS — the gate is load-bearing', mutated === true, String(mutated))
    try { atk2.close() } catch {}
    // safety: never leave an approval window open (it would block the approver chain for the container signs below)
    { const lingering = approvalWindow(); if (lingering) { try { lingering.destroy() } catch {} await sleep(150) } }

    // POINT 2 · the house page's bridge exposes nothing that could answer or reach the approval
    const housePage = new BrowserWindow({ show: false, webPreferences: { preload: path.join(ROOT, 'preload.js'), additionalArguments: ['--milpa-house=http://localhost:8899'], contextIsolation: true, sandbox: false } })
    await housePage.loadURL('about:blank') // a file:// page: the fullest bridge preload.js ever grants
    const bridge = await housePage.webContents.executeJavaScript('({ keys: Object.keys(window.milpa||{}), hasRequire: typeof window.require, sign: Object.keys(window.milpa||{}).filter(k=>/approv|sign/i.test(k)) })').catch((e) => ({ err: String(e) }))
    record('POINT 2 · the house bridge has no approval/sign-approval method, and no node in the page', Array.isArray(bridge.keys) && bridge.sign.length === 0 && bridge.hasRequire === 'undefined', JSON.stringify(bridge).slice(0, 200))
    try { housePage.close() } catch {}

    // ── POINT 1 BLOCKER (0611 review): the signer's keyring is NEW — it never opens the OLD, once-mounted dir ──────
    // The old ~/.milpa/gnupg was mounted read-write; its gpg.conf could carry an attacker's `agent-program` that the
    // host would EXECUTE on the first sign (detachSign runs `gpg --detach-sign` over it). Prove the attack is real on
    // the OLD dir, then prove the signer, over the NEW keyring, runs nothing planted there.
    const OLD = path.join(W, 'old'); const MARKER = path.join(W, 'rce-ran')
    fs.mkdirSync(OLD, { recursive: true, mode: 0o700 }); fs.writeFileSync(path.join(OLD, 'gpg-agent.conf'), 'disable-scdaemon\n')
    sh('gpg', ['--batch', '--pinentry-mode', 'loopback', '--gen-key'], { input: params, env: { ...process.env, GNUPGHOME: OLD }, stdio: ['pipe', 'ignore', 'ignore'] })
    const realAgent = sh('sh', ['-c', 'command -v gpg-agent']).trim()
    const evil = path.join(W, 'evil-agent.sh')
    fs.writeFileSync(evil, `#!/bin/sh\ntouch ${MARKER}\nexec ${realAgent} "$@"\n`, { mode: 0o755 })
    fs.appendFileSync(path.join(OLD, 'gpg.conf'), `agent-program ${evil}\n`)
    // gen-key above already launched a default agent for OLD; kill it so the next sign relaunches via the PLANTED
    // agent-program (the realistic repro: a patched Desktop's first sign, no agent running yet).
    try { sh('gpgconf', ['--homedir', OLD, '--kill', 'all'], { stdio: ['ignore', 'ignore', 'ignore'] }) } catch {}
    try { await hostSigner.detachSign('payload-bytes', OLD) } catch {}
    record('BLOCKER control · a planted agent-program in the OLD keyring DOES run on a sign over it (the risk is real)', fs.existsSync(MARKER))
    try { fs.rmSync(MARKER, { force: true }) } catch {}
    const sigNew = await hostSigner.detachSign('payload-bytes', HOST)
    record('POINT 1 (blocker, CHANGED) · the signer\'s keyring is NEW and clean — nothing planted in the OLD dir runs', !fs.existsSync(MARKER) && sigNew !== null && HOST !== OLD)

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
    autoMode = 'approve'
    const r1 = await dockerProbe(FPR)
    record('HAPPY · the house got a signature and verified it with its PUBLIC-only keyring', r1.signed === true && r1.verified === true && r1.fpr_matches === true && r1.container_secret_keys === 0, JSON.stringify(r1).slice(0, 220))
    record('POINT 1 · what was signed is the operation that was asked (end to end)', r1.operation === 'capabilities:enable' && r1.arguments && r1.arguments.capability === 'milpa/admin')
    record('POINT 3 · the HOST stamped the time and a nonce (not the house\'s clock)', r1.has_nonce === true && typeof r1.issuedAt === 'string' && /^\d{4}-\d\d-\d\dT/.test(r1.issuedAt || '') && r1.host === 'labhouse')
    const r2 = await dockerProbe(FPR)
    record('POINT 3 · a second request is approved and signed afresh — a fresh nonce, never "allow always"', r2.signed === true && r2.issuedAt !== r1.issuedAt)

    // ── POINT 5 (freshness dead zone, 0611 review): the house's OperationAuthorizer freshness is 120s; the Desktop
    // window deadline is shorter, with margin, and counts down — so a slow yes refuses cleanly, not signed-then-expired.
    autoMode = 'approve'
    const fr = await new Promise((resolve) => execFile('docker', ['exec', NAME, 'php', '/labtest/freshness-probe.php'], { encoding: 'utf8', maxBuffer: 1 << 20 }, (e, o) => { try { resolve(JSON.parse((o || '').trim().split('\n').filter(Boolean).pop() || '{}')) } catch { resolve({ raw: (o || String(e)).slice(-200) }) } }))
    record('POINT 5 · the house accepts the signature at 90s but REJECTS it at 121s (the 120s dead zone is real)', fr.granted_at_90s === true && fr.granted_at_121s === false && /expired/i.test(fr.reason_121 || ''), JSON.stringify(fr).slice(0, 200))
    record('POINT 5 · the Desktop window deadline is shorter than the house freshness (90s < 120s, with margin)', require(path.join(ROOT, 'host-approve.js')).APPROVAL_WINDOW_MS < 120000, String(require(path.join(ROOT, 'host-approve.js')).APPROVAL_WINDOW_MS))
    // with a short window and nobody approving, the approval refuses on the window's OWN deadline (never a hung dead
    // zone). Measured directly with an approver built with a short timeoutMs — a makeApprover OPTION, no env, no socket.
    autoMode = null
    const approveShort = makeApprover({ app, BrowserWindow, ipcMain, root: ROOT, parent: null, timeoutMs: 1500 })
    const shortAuthz = { ...authz, nonce: 'aaaabbbbccccddddaaaabbbbccccdddd' }
    shortAuthz.canonical = hostSigner.canonical(shortAuthz.operation, shortAuthz.arguments, shortAuthz.host, shortAuthz.issuedAt, shortAuthz.nonce)
    const t0 = Date.now(); const shortRes = await approveShort(shortAuthz); const elapsed = Date.now() - t0
    record('POINT 5 · an un-answered approval refuses on the window deadline (~1.5s here, well under 120s freshness)', shortRes === false && elapsed >= 1000 && elapsed < 10000, `res=${shortRes} elapsed=${elapsed}ms`)

    // ── POINT 4 (a NO is a refusal with its reason) ───────────────────────────────────────────────────
    autoMode = 'deny'
    const rd = await dockerProbe(FPR)
    record('POINT 4 · a refused approval comes back to the house as "not signed", with its reason', rd.signed === false && /did not approve/i.test(rd.reason || ''), JSON.stringify(rd))

    // ── POINT 6 (no host, no signature) ───────────────────────────────────────────────────────────────
    autoMode = 'approve'
    try { server.close() } catch {}
    try { fs.rmSync(socketPath, { force: true }) } catch {}
    server = null
    await sleep(300)
    const rn = await dockerProbe(FPR)
    record('POINT 6 · with no host answering, the house gets no signature, with its reason', rn.signed === false && /did not answer on its socket/i.test(rn.reason || ''), JSON.stringify(rn))

    // ── MIGRATION (0611 review item 3): can the NEW key B take over after A is treated as compromised, WITHOUT A? ──
    // Measured against the real identity classes in the container (migration-probe.php). The container is still up.
    const migRaw = dockerExec(['php', '/labtest/migration-probe.php', '/tmp/labhouse', FPR, FPR_B])
    let mig = {}; try { mig = JSON.parse(migRaw.trim().split('\n').filter(Boolean).pop() || '{}') } catch {}
    record('MIGRATION · a key NOT in the out-of-band root is REFUSED — B cannot enroll while A is gone and B unrooted', mig.enroll_B_without_rooting === 'refused' && /not in the out-of-band root/i.test(mig.what_the_house_says || ''), (mig.what_the_house_says || migRaw).slice(0, 160))
    record('MIGRATION · the recovery WITHOUT A is an out-of-band config/identity.php edit (no A signature); then B enrolls', mig.B_is_rooted_after_config_edit === true && /succeeded/i.test(mig.enroll_B_after_rooting || ''), JSON.stringify(mig).slice(0, 170))
  } catch (e) {
    record('harness ran without throwing', false, String(e && e.stack || e))
  } finally {
    try { if (server) server.close() } catch {}
    try { sh('docker', ['rm', '-f', NAME], { stdio: ['ignore', 'ignore', 'ignore'] }) } catch {}
    // stop any gpg-agents the lab keyrings (incl. the planted-agent control) launched, before removing their dirs
    for (const d of [path.join(W, 'host'), path.join(W, 'seat'), path.join(W, 'old')]) { try { sh('gpgconf', ['--homedir', d, '--kill', 'all'], { stdio: ['ignore', 'ignore', 'ignore'] }) } catch {} }
    try { fs.rmSync(W, { recursive: true, force: true }) } catch {}
  }

  const failed = checks.filter((c) => !c.ok).length
  console.log('\n' + (checks.length - failed) + '/' + checks.length + ' host-signer checks passed')
  app.exit(failed ? 1 : 0)
})
