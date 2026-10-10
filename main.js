// Milpa Desktop — the Electron host. The backend is a milpa app in a Docker container; the window is that house's
// own panel. This main process owns what the page must never touch:
//   1. the container lifecycle       — `docker run` on ready, stop on quit;
//   2. the window                    — a local boot screen while the house comes up, then the house's panel at the
//                                       origin the Desktop declared to it (greenhouse evidence/1091, E3);
//   3. driving the agent             — run `coa agent <query>` in the container against the configured model.
// THE DESKTOP HOLDS NO CREDENTIAL. It used to mint a Bearer with an unsigned `coa token:new --scopes=*` on every start;
// since decisions/0522 an unsigned call that changes something lasting is refused, so the token was null, the window
// never left «bringing the runtime up», and there was no passkey window and no hub (evidence/1091). Signing that mint
// would cost a signature on every launch for a credential nobody should hold. The person signs in to the panel with
// their passkey, in this window, and the house judges every call as theirs. Model defaults to the local qwen, overridable.
const { app, BrowserWindow, ipcMain, Menu, dialog, net, shell } = require('electron')

// Native Wayland when the session is Wayland — XWayland's compositing can leave stale repaints (the
// conversation bleeding over the header/inspector). `ozone-platform-hint=auto` picks Wayland when it
// is there, which repaints cleanly; on X11 it is a no-op.
if (process.env.XDG_SESSION_TYPE === 'wayland' || process.env.WAYLAND_DISPLAY) {
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto')
}
const { execFile, execFileSync } = require('node:child_process')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

// KEY CUSTODY (greenhouse decisions/0611, supersedes 0121). The person's signing key NEVER enters the container. The
// Electron MAIN is the host signer: it holds the key, SHOWS each operation, signs only on the person's approval
// (host-signer.js + host-approve.js), and the container only VERIFIES, holding public keys. The old mounts — the host
// GNUPGHOME at /root/.gnupg and the pcscd socket — are GONE (GHSA-fjwx-8j4j-cqfq); the house signs through a unix
// socket the main binds in (sign-wiring.js). A seat's key lives in its OWN host keyring, apart from the person's.
//
// THE SIGNER'S KEYRING IS NEW — one no container ever saw. The keyring affected versions mounted read-write into the
// container (and the old keygen wrote its config there) could carry an attacker's `agent-program` / `pinentry-program`
// / `scdaemon-program` in its gpg config; running `gpg` over that dir — even to EXPORT — would execute the planted
// program on the HOST at the first sign. So the patched Desktop never opens that dir. The old key is treated as
// COMPROMISED: the person generates a new key in this fresh keyring and re-enrolls. The override env is a NEW name too,
// so a pre-existing override that pointed at the mounted dir can never select the signer's keyring.
const HOST_GNUPG = process.env.MILPA_HOST_GNUPGHOME || path.join(os.homedir(), '.milpa', 'host-gnupg')
const HOST_GNUPG_SEAT = process.env.MILPA_HOST_GNUPGHOME_SEAT || path.join(os.homedir(), '.milpa', 'host-gnupg-seats')
// PLATFORM. On Linux, `--network host` lets the container reach the local model and serves the board on
// the host directly. On macOS (and Windows), Docker runs in a VM where `--network host` binds the VM,
// NOT the host — so we publish the port instead, and a model on the Mac is reached via host.docker.internal.
const IS_MAC = process.platform === 'darwin'

// The distributable binary defaults to the PUBLIC dev image (pulled from ghcr, no clone, no auth): a downloaded
// Milpa Desktop is self-contained beyond needing Docker. House devs override with a local tag via MILPA_IMAGE
// (run-desktop.sh sets the graduated one).
//
// THE FRANKENPHP VARIANT FIRST, THE PLAIN IMAGE AS THE FLOOR (greenhouse decisions/0508). `:dev-frankenphp` is the
// same app served by FrankenPHP classic with the Mercure hub built in on the app's own port: the Desktop runs it
// with ITS OWN command (the entrypoint mints the hub's keys per container) and subscribes to the hub instead of
// polling. When that tag cannot be had — not pulled yet and no network, or not published yet — the plain `:dev`
// still runs, under `php -S` with several workers, and the renderer polls as before. MILPA_IMAGE names one image
// and skips the choice; which server it gets is read from the image, not from its name.
const { chooseImage, IMAGE_PREFERRED } = require('./choose-image.js')
const openWhere = require('./open-where.js')
// 0611: the house signs through the host. These three are the host signer, the docker-run wiring that ties its socket
// to the container (and drops the key mounts), and the approval window the main owns.
const hostSigner = require('./host-signer.js')
const signWiring = require('./sign-wiring.js')
const { makeApprover } = require('./host-approve.js')
let IMAGE = process.env.MILPA_IMAGE || IMAGE_PREFERRED
let SERVER = 'php-s'   // or 'frankenphp' — read from the image in startBackend()
let HUB = false        // whether the backend answers as a Mercure hub on its own port — probed, not assumed
let TRIAL = false      // whether the house can confine a seat's trial — asked of the house, not assumed
// The container's name. A lab running beside another Desktop names its own; everyone else keeps the default.
const NAME = process.env.MILPA_BACKEND || 'milpa-desktop-backend'
// HOW A PERSON REACHES THE HOUSE'S TERMINAL FROM THIS MACHINE (greenhouse evidence/1091, E5). The house prints the
// commands it hands a person — the seat's `identity:accept`, the hints to continue or to answer — as `php bin/coa …`,
// which only runs inside the container. The Desktop is the process that knows the house is in one, so it declares the
// way in (MILPA_CLI_PREFIX, app-runtime Capabilities::cli()) and the house prints every command with it; `-it` because
// a person types them, and a smartcard's PIN needs a terminal.
const TERMINAL = `docker exec -it ${NAME}`
const HOST_PORT = process.env.MILPA_PORT || '8899'
const BASE = `http://127.0.0.1:${HOST_PORT}`
// THE ADDRESS BAR THE PASSKEY WINDOW SHOWS (greenhouse decisions/0534). milpa/auth 0.11 holds every ceremony to the
// origins the house admits, and neither what config/app.php declares nor what the house derives (http://localhost:8000)
// is the port the Desktop chose — so its passkey window was refused (evidence/1068). The Desktop is the process that
// serves the house here and the only one that knows this address; it declares it to the house, never the request.
const PASSKEY_ORIGIN = `http://localhost:${HOST_PORT}`
const MODEL = { base: process.env.MILPA_AGENT_BASE_URL || 'http://llama.local:11438', name: process.env.MILPA_AGENT_MODEL || 'qwen3.8-27b' }
// THE MODEL'S WINDOW IS THE HOUSE'S TO MEASURE (greenhouse evidence/1091, E2). The Desktop used to declare 24576 —
// a qwen-32k minus its tool share — on every `docker run` and every drive, and the house obeys a declared window over
// the one it measures: with the model at 49,152 the first two legs died in `context_budget_exhausted`. Now the Desktop
// declares a window only when the operator names one (MILPA_AGENT_CONTEXT_TOKENS); otherwise it says nothing and the
// house asks the model.
const CTX = process.env.MILPA_AGENT_CONTEXT_TOKENS || ''
const ctxEnv = () => CTX ? ['-e', `MILPA_AGENT_CONTEXT_TOKENS=${CTX}`] : []
// The panel (milpa/admin), through its sign-in: the passkey sign-in is a session cookie, so it ends with whatever
// holds it, and a panel opened with nobody signed in offers no way in. One touch of the passkey per launch — never a
// gpg signature. WHERE it opens is the person's choice (greenhouse decisions/0566): the boot screen offers this window
// and the browser (open-where.js). A security key's PIN is asked by the Desktop itself where it can reach the key
// (decisions/0568, KEY_PIN below); where it cannot, the browser is the first offer.
const PANEL_URL = `${PASSKEY_ORIGIN}/milpa/admin`
const SIGNIN_URL = `${PASSKEY_ORIGIN}/webauthn/signin?next=${encodeURIComponent('/milpa/admin')}`
// WHAT A WINDOW THAT SHOWS THE HOUSE IS GIVEN (greenhouse decisions/0568). The one preload, told which origin is the
// house: on the Desktop's own file: pages it exposes the bridge; on a page of the house it exposes nothing of that —
// only a `navigator.credentials` that can ask for a security key's PIN, which Chromium in Electron cannot.
// Whether this window can ask for a security key's PIN: where the Desktop can reach the key itself — Linux, through
// hidraw (security-key/hid.js). Elsewhere it cannot yet, and the boot screen keeps the browser first (decisions/0566).
const KEY_PIN = process.platform === 'linux'
const HOUSE_PAGE = { preload: path.join(__dirname, 'preload.js'), additionalArguments: [`--milpa-house=${PASSKEY_ORIGIN}`] }
// What the window shows while it is not the panel yet — read by the boot screen through `milpa:boot`.
const BOOT = { phase: 'starting', error: null, panel: false }
let win = null
let signServer = null   // the host signer (0611); bound before the container, closed on quit
const VERSION = require('./package.json').version

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts }).trim()
const exec = (cmd, args, opts = {}) => new Promise((res) => {
  execFile(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 24, ...opts }, (err, out) => res({ err, out: out || '' }))
})

async function startBackend () {
  // MILPA_KEEP_BACKEND=1: attach to an already-running backend instead of recreating it — the knob
  // that lets the UI restart (to pick up a shell fix) WITHOUT killing the live sessions inside the
  // container. Measured need: a session mid-build died with the container on every relaunch.
  if (process.env.MILPA_KEEP_BACKEND === '1') {
    try {
      const up = sh('docker', ['ps', '--filter', `name=^${NAME}$`, '--format', '{{.Names}}'])
      if (up === NAME) {
        for (let i = 0; i < 10; i++) { try { const r = await fetch(`${BASE}/`); if (r.status < 500) break } catch {} await new Promise(r => setTimeout(r, 500)) }
        try { SERVER = serverOf(sh('docker', ['inspect', '--format', '{{.Config.Image}}', NAME])) } catch {}
        // The kept container still mounts the socket dir (stable under userData): rebind the signer so it can sign.
        await startHostSigner(path.join(app.getPath('userData'), 'sign'))
        HUB = await probeHub()
        TRIAL = probeTrial()
        return
      }
    } catch {}
  }
  try { sh('docker', ['rm', '-f', NAME]) } catch {}
  IMAGE = chooseImage()
  SERVER = serverOf(IMAGE)
  // 0611: bind the host signer on a socket and mount only THAT into the container — NO keyring, NO pcscd. The house
  // signs through the host; the private key never enters it. The socket dir is under userData (stable across runs).
  const signSocketDir = path.join(app.getPath('userData'), 'sign')
  try { fs.mkdirSync(signSocketDir, { recursive: true, mode: 0o700 }) } catch {}
  await startHostSigner(signSocketDir)
  const mounts = signWiring.containerSignArgs(signSocketDir)
  // On Linux, host networking; on macOS, publish the port (host networking is a no-op in the VM there).
  const net = IS_MAC ? ['-p', `${HOST_PORT}:${HOST_PORT}`] : ['--network', 'host']
  // The model config goes on the CONTAINER (not just per docker-exec), so the agent web door
  // (POST /agent over HTTP, greenhouse decisions/0155) reaches the local model too.
  const modelEnv = ['-e', `MILPA_AGENT_BASE_URL=${MODEL.base}`, '-e', `MILPA_AGENT_MODEL=${MODEL.name}`, '-e', 'MILPA_AGENT_BASIC_AUTH=', ...ctxEnv()]
  // FrankenPHP keeps the image's own entrypoint and command: they read PORT, and the entrypoint is what tells the
  // app its server is its hub. `php -S` replaces the command, and gets several workers so a long request (a
  // stream, a turn) does not hold the next one (decisions/0504) — set here too, for an image that predates the ENV.
  const serve = SERVER === 'frankenphp'
    ? [IMAGE]
    : ['-e', 'PHP_CLI_SERVER_WORKERS=8', IMAGE, 'php', '-S', `0.0.0.0:${HOST_PORT}`, '-t', 'public', 'public/index.php']
  sh('docker', ['run', '-d', '--name', NAME, ...net, ...trialSeccomp(IMAGE), '-e', `PORT=${HOST_PORT}`, '-e', `MILPA_PASSKEY_ORIGINS=${PASSKEY_ORIGIN}`, '-e', `MILPA_CLI_PREFIX=${TERMINAL}`, ...modelEnv, ...mounts, ...serve])
  let answered = false
  for (let i = 0; i < 40 && !answered; i++) { try { const r = await fetch(`${BASE}/`); answered = r.status < 500 } catch {} if (!answered) await new Promise(r => setTimeout(r, 800)) }
  if (!answered) throw new Error(`the house did not answer on ${BASE} — docker logs ${NAME}`)
  // 0611: leave the container with PUBLIC keys only — export whatever the host holds, import it in, confirm 0 secrets.
  // -1 means the check could not run (not "0 secrets") — say that too.
  try {
    const prov = signWiring.provisionPublicKeyring({ container: NAME, hostGnupg: HOST_GNUPG })
    if (prov.secret > 0) console.warn(`[host-signer] WARNING: container holds ${prov.secret} secret key(s) — expected 0 (0611)`)
    else if (prov.secret < 0) console.warn('[host-signer] WARNING: could not verify the container holds no secret keys (0611)')
  } catch {}
  HUB = await probeHub()
  TRIAL = probeTrial()
}
// Bind the host signer (0611): the Electron main holds the person's key, shows each operation in a window the house
// cannot reach, and signs on approval. `socketDir` is mounted into the container as /run/milpa; the house asks here.
async function startHostSigner (socketDir) {
  try { fs.mkdirSync(HOST_GNUPG, { recursive: true, mode: 0o700 }) } catch {}
  try { fs.mkdirSync(HOST_GNUPG_SEAT, { recursive: true, mode: 0o700 }) } catch {}  // the seat's key, its own keyring
  const socketPath = signWiring.hostSocketPath(socketDir)
  // The approval window deadline is shorter than the house's freshness window (OperationAuthorizer = 120s), with
  // margin, so a slow approval refuses CLEANLY rather than signing into a dead zone that the house rejects as expired
  // AFTER the person said yes (0611 review). The decision is also persisted — console.log alone is unread in a packaged app.
  const logFile = path.join(app.getPath('userData'), 'host-signer.log')
  const approve = makeApprover({ app, BrowserWindow, ipcMain, root: __dirname, parent: win, logFile })
  try { if (signServer) signServer.close() } catch {}
  signServer = hostSigner.serve({ socketPath, gnupgHome: HOST_GNUPG, approve })
  await new Promise((resolve) => { try { signServer.once('listening', resolve); signServer.once('error', resolve) } catch { resolve() } })
}
// Whether the house serves its panel yet: a fresh house has none until `capabilities:enable milpa/admin` (404).
async function panelServed () {
  try { const r = await fetch(PANEL_URL, { redirect: 'manual', signal: AbortSignal.timeout(3000) }); try { await r.body?.cancel() } catch {} return r.status !== 404 && r.status < 500 } catch { return false }
}
// Read from the image, not its tag: the FrankenPHP variant's entrypoint is `milpa-frankenphp` (greenhouse
// docker/milpa-dev-frankenphp.Dockerfile). Anything else is served by `php -S`.
function serverOf (image) {
  try { return /milpa-frankenphp/.test(sh('docker', ['image', 'inspect', '--format', '{{json .Config.Entrypoint}}', image])) ? 'frankenphp' : 'php-s' } catch { return 'php-s' }
}
// A hub is known by what it answers (greenhouse decisions/0504): a topic-less subscription is refused with 400
// (anonymous allowed) or 401 (JWT first). `php -S` answers 404 — no hub, so the renderer polls.
async function probeHub () {
  try { const r = await fetch(`${BASE}/.well-known/mercure`, { signal: AbortSignal.timeout(3000) }); try { await r.body?.cancel() } catch {} return r.status === 400 || r.status === 401 } catch { return false }
}
// A SEAT BUILDS INSIDE THE CONTAINER (greenhouse decisions/0558). `make` / `implement` from a seat run in a confined
// trial — bubblewrap, a read-only root, no network, its own pids (decisions/0530) — and inside Docker the house is
// root without CAP_SYS_ADMIN, where bubblewrap can make namespaces only in a USER namespace. Docker's default seccomp
// profile forbids that; the image carries a profile that is Docker's default plus the four syscalls it takes
// (clone, mount, pivot_root, umount2), and the Desktop hands it to `docker run`. Measured (evidence/1092): the trial
// gets its whole confinement, the container keeps Docker's default capabilities and still cannot mount. It is NOT
// `--privileged`. The profile is read from the image that is about to run, so it always matches what that image
// expects; an image without one runs as before — without a trial, which the house reports instead of faking.
function trialSeccomp (image) {
  try {
    const profile = sh('docker', ['run', '--rm', '--entrypoint', 'cat', image, '/usr/local/share/milpa/trial-seccomp.json'], { stdio: ['ignore', 'pipe', 'ignore'] })
    JSON.parse(profile)
    const file = path.join(app.getPath('userData'), 'trial-seccomp.json')
    fs.writeFileSync(file, profile, { mode: 0o600 })
    return ['--security-opt', `seccomp=${file}`]
  } catch { return [] }
}
// Whether the house can confine a trial here, in its own words (app-runtime TrialRunner::available()).
function probeTrial () {
  try { return sh('docker', ['exec', NAME, 'php', '-r', 'require "vendor/autoload.php"; echo (new Milpa\\AppRuntime\\Agent\\TrialRunner())->available() ? "yes" : "no";']) === 'yes' } catch { return false }
}
function stopBackend () {
  try { if (signServer) { signServer.close(); signServer = null } } catch {}
  if (process.env.MILPA_KEEP_BACKEND === '1') return
  try { sh('docker', ['rm', '-f', NAME]) } catch {}
}

// ── IPC: the narrow bridge the preload exposes ─────────────────────────────────────────────────
// ONLY THE DESKTOP'S OWN PAGES MAY CALL IT. The window shows the house's panel — a page served over http that also
// shows what a resident built — and this bridge runs docker and gpg. The preload exposes nothing to an http page;
// this is the second lock: a call whose frame is not a file:// page of this app is refused before its handler runs.
const ownPage = (e) => { try { return new URL(e.senderFrame.url).protocol === 'file:' } catch { return false } }
const handle = (channel, fn) => ipcMain.handle(channel, (e, ...args) => ownPage(e) ? fn(e, ...args) : { ok: false, error: 'refused: not a page of this Desktop' })
handle('milpa:api', async (_e, p) => {
  try { const r = await fetch(`${BASE}${p}`)
        const text = await r.text(); try { return { ok: r.ok, status: r.status, json: JSON.parse(text) } } catch { return { ok: r.ok, status: r.status, text } } }
  catch (e) { return { ok: false, error: String(e) } }
})

// The passkey ceremony opens in ITS OWN window, loaded over http://localhost — never the file:// main
// renderer, because WebAuthn refuses a file:// origin and an IP is not a valid relying-party id
// (greenhouse decisions/0187, evidence/0465-0467). localhost resolves to the same container the API
// uses, so the served page (/webauthn/enroll, /webauthn/intent) runs `navigator.credentials.*` at a
// real origin with rpId `localhost`, shows the human the operation, and posts the assertion back to the
// backend that verifies it. The window is a child of the main one and holds no privilege of its own.
// That window's origin is PASSKEY_ORIGIN, the one startBackend() declared to the house.
handle('milpa:passkey', async (_e, { kind, session: sid, operation, args } = {}) => {
  const base = PASSKEY_ORIGIN
  let url
  if (kind === 'intent') {
    const q = new URLSearchParams({ operation: String(operation || ''), arguments: JSON.stringify(args || {}), session: String(sid || '') })
    url = `${base}/webauthn/intent?${q.toString()}`
  } else {
    url = `${base}/webauthn/enroll`
  }
  try {
    const w = new BrowserWindow({
      width: 460, height: 520, title: kind === 'intent' ? 'Approve operation' : 'Register a passkey',
      backgroundColor: '#ffffff', autoHideMenuBar: true,
      webPreferences: { ...HOUSE_PAGE, contextIsolation: true, nodeIntegration: false },
    })
    await w.loadURL(url)
    return { opened: true, url }
  } catch (e) { return { opened: false, error: String(e) } }
})
// The agent over the WEB CHANNEL (greenhouse decisions/0155): the same HTTP surface the live door
// uses, not docker exec. main proxies these to the container's exposed agent operations with the
// Bearer; a founded app that does NOT expose them (config/http.php) falls back to docker exec so an
// unwired container still drives. This is what makes Electron a pure web-channel host.
// When set, the agent path is HTTP-only (no docker-exec fallback) — proves Electron talks the web
// channel to the agent, and is the honest mode once the container always exposes the door.
const AGENT_HTTP_ONLY = !!process.env.MILPA_AGENT_HTTP_ONLY
async function agentHttp (method, path, body) {
  const headers = { Accept: 'application/json' }
  if (body) headers['Content-Type'] = 'application/json'
  // Chromium's net.fetch, NOT Node's: undici's default headersTimeout (~5 min) aborted long agent
  // drives mid-run — a 12-step qwen turn at a 27k window takes longer than that — and the abort both
  // killed the in-container run at the next output and fell through to a SECOND exec drive on the
  // same session. Measured as three identical generic deaths ~7 minutes apart. The Chromium stack
  // carries no such deadline.
  const doFetch = net && net.fetch ? net.fetch.bind(net) : fetch
  const r = await doFetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
  const data = await r.json().catch(() => null)
  return { status: r.status, data }
}
handle('milpa:drive', async (_e, { query, session: sid, mode }) => {
  const s = sid || 'default'
  // Default autonomy is `auto` (Rod, 2026-09-02): a fresh session continues without pausing on every
  // mutation. The gate still stops for signatures and underdetermined intent server-side — this only
  // sets the DEFAULT, never widens the gate. `ask` remains selectable in Settings.
  const m = (mode === 'ask' || mode === 'auto') ? mode : 'auto'
  // DRIVE GOES OVER EXEC, not HTTP. A drive is a MINUTES-long blocking request; every HTTP client
  // in this stack carries some deadline (undici's headersTimeout killed it first, Chromium's
  // ~300s transaction timeout killed it next), and when the client dies the PHP run KEEPS GOING
  // server-side — the UI reports death over a leg that is alive, and a retry stacks a second
  // concurrent leg on the same session. Measured three separate evenings. The exec path has no
  // deadline and its output is captured reliably. The web door (decisions/0155) remains the channel
  // for everything short — answer, show, reads; the long-running drive earns the exception until
  // the door grows an async accept-and-poll shape (board: C-3, surrender the turn).
  if (AGENT_HTTP_ONLY) {
    try {
      const { status, data } = await agentHttp('POST', '/agent', { query, session: s, mode: m })
      if (status !== 404) { const r = (data && data.result) ? data.result : (data || {}); return { ok: status < 300 && r.ok !== false, session: s, answer: r.answer, steps: r.steps, tools: r.tools, closure: r.closure, error: r.error || (status >= 300 ? `HTTP ${status}` : undefined) } }
    } catch {}
    return { ok: false, session: s, answer: null, error: 'agent web door unreachable (http-only)' }
  }
  // the drive path: docker exec (no client deadline can kill a live run)
  const { err, out } = await exec('docker',
    ['exec', '-e', `MILPA_AGENT_BASE_URL=${MODEL.base}`, '-e', `MILPA_AGENT_MODEL=${MODEL.name}`, '-e', 'MILPA_AGENT_BASIC_AUTH=', ...ctxEnv(),
     NAME, 'php', 'bin/coa', 'agent', query, `--session=${s}`, `--mode=${m}`, '--json'])
  let doc = null; try { doc = JSON.parse(out.trim().split('\n').filter(Boolean).pop()) } catch {}
  if (doc) { const r = (doc && doc.result) ? doc.result : doc; return { ok: r.ok !== false && !err, session: s, answer: r.answer, steps: r.steps, tools: r.tools, closure: r.closure, error: r.error } }
  const grab = (k) => (out.match(new RegExp(`^${k}:\\s*([\\s\\S]*?)(?=\\n\\w+:|$)`, 'm')) || [])[1]?.trim()
  return { ok: !err, session: s, answer: grab('answer'), steps: grab('steps'), tools: grab('tools'), raw: out.slice(-4000) }
})
handle('milpa:answer', async (_e, { session: sid, decision }) => {
  try {
    const { status, data } = await agentHttp('POST', '/agent/answer', { session: sid, answer: decision })
    if (status !== 404) return { ok: status < 300, out: JSON.stringify(data) }
  } catch {}
  if (AGENT_HTTP_ONLY) return { ok: false, out: 'agent web door unreachable (http-only)' }
  const { err, out } = await exec('docker', ['exec', NAME, 'php', 'bin/coa', 'agent:answer', `--session=${sid}`, `--answer=${decision}`, '--json'])
  return { ok: !err, out }
})
handle('milpa:show', async (_e, sid) => {
  const s = sid || 'default'
  try {
    const { status, data } = await agentHttp('GET', `/agent/show?session=${encodeURIComponent(s)}`)
    if (status !== 404 && data) return (data.result || data)
  } catch {}
  if (AGENT_HTTP_ONLY) return { ok: false, error: 'agent web door unreachable (http-only)' }
  const { out } = await exec('docker', ['exec', NAME, 'php', 'bin/coa', 'agent:show', `--session=${s}`, '--json'])
  try { const d = JSON.parse(out.trim().split('\n').filter(Boolean).pop()); return d.result || d } catch { return { ok: false } }
})
// Whether a DRIVING `coa agent` run is live in the container (only the driver carries --mode=; agent:show /
// agent:answer do not). On startup the renderer uses this to tell an INTERRUPTED prior run — tasks mid-flight,
// no agent process — from an ongoing one: killing the window kills the exec and leaves work half-done, and the
// UI must say so rather than look frozen. It does NOT auto-resume; Continuar is the user's verb (decisions/0132).
// Host a Milpa live web component: the container renders it framework-side (a signed <milpa-state> envelope +
// Alpine markup) and the shell hosts the HTML — a Desktop screen authored the Milpa way, not hand-written here
// (greenhouse decisions/0142). The per-app component route is wired by the container's live-web surface.
handle('milpa:component', async (_e, name) => {
  const n = encodeURIComponent(String(name || 'data-table'))
  // The framework's live door (milpa/app-runtime LivePlugin) serves the interactive render path at
  // GET /live/page?component=<name> — the page is born bound to this actor and immediately actionable
  // over POST /live (greenhouse decisions/0149, evidence/0412).
  try {
    const r = await fetch(`${BASE}/live/page?component=${n}`)
    if (r.ok) return { ok: true, html: await r.text() }
  } catch {}
  return { ok: false, error: 'live component surface not wired to this container (needs milpa/live-web + LivePlugin + a LivePageProvider)' }
})
// The bridge transport for a hosted live component: proxy the remote runtime's action POST to the
// container's live endpoint. The renderer's page is file://, so it cannot fetch the backend directly;
// main can. Returns { status, data } — exactly what window.MilpaLive.transport must resolve to.
handle('milpa:live', async (_e, { endpoint, body }) => {
  const url = /^https?:/.test(String(endpoint || '')) ? endpoint : `${BASE}${endpoint || '/live'}`
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify(body || {}),
    })
    let data = null; try { data = await r.json() } catch {}
    return { status: r.status, data }
  } catch (e) {
    return { status: 0, data: { error: 'live endpoint unreachable: ' + String(e && e.message || e) } }
  }
})
handle('milpa:stopAgent', async () => {
  // Interrupt an in-flight run so the user can steer with fresh context. Each turn is already persisted,
  // so killing the exec stops the loop without losing the work — Continue resumes from the last fact.
  try { await exec('docker', ['exec', NAME, 'pkill', '-f', 'bin/coa agent']) } catch {}
  return { ok: true }
})
handle('milpa:agentRunning', async () => {
  const { out } = await exec('docker', ['exec', NAME, 'sh', '-c', "pgrep -f 'coa agent .*--mode=' >/dev/null 2>&1 && echo yes || echo no"])
  return { running: /yes/.test(out) }
})
// Who the house recognizes as this session's owner right now — re-verified live by the backend
// (coa session:owner). The renderer PROJECTS this fact; it never decides it (greenhouse decisions/0120).
handle('milpa:owner', async (_e, sid) => {
  const { out } = await exec('docker', ['exec', NAME, 'php', 'bin/coa', 'session:owner', `--session=${sid || 'default'}`, '--json'])
  try { const d = JSON.parse(out.trim().split('\n').filter(Boolean).pop()); return d.result || d } catch { return { ok: false } }
})
// The session stream — model_called / tool_called / turn — read so the UI shows the agent's work while
// `coa agent` is still running. With a hub (the FrankenPHP variant) the renderer reads it when the hub rings
// (milpa:subscribe below); without one it polls it. The turn runs through `docker exec`, not through a request
// a stream could ride — so the push comes from the hub the runtime publishes to, not from the drive.
// Save an audit export the renderer composed. The renderer owns the FORMAT (categorising the stream,
// weighing each component); the main process only owns the file — a Save dialog, then a write. The
// content never leaves the host.
handle('milpa:saveExport', async (_e, { name, content } = {}) => {
  try {
    const safe = String(name || 'milpa-session').replace(/[^\w.-]/g, '_')
    const res = await dialog.showSaveDialog({
      title: 'Export session audit',
      defaultPath: path.join(os.homedir(), safe + '.md'),
      filters: [{ name: 'Markdown', extensions: ['md'] }, { name: 'Text', extensions: ['txt'] }],
    })
    if (res.canceled || !res.filePath) return { ok: false, canceled: true }
    fs.writeFileSync(res.filePath, String(content || ''), 'utf8')
    return { ok: true, path: res.filePath }
  } catch (e) {
    return { ok: false, error: String(e && e.message || e) }
  }
})

handle('milpa:events', async (_e, { session: sid, since }) => {
  const stream = 'agent-session:' + (sid || 'default')
  const { out } = await exec('docker', ['exec', NAME, 'sh', '-c',
    `grep -F '${stream.replace(/'/g, '')}' var/agent-sessions.jsonl 2>/dev/null || true`])
  const events = []
  for (const l of out.split('\n')) { if (!l) continue; try { const e = JSON.parse(l); if (e.stream_id === stream) events.push({ type: e.type, payload: e.payload || {} }) } catch {} }
  return { total: events.length, events: events.slice(Math.max(0, since || 0)) }
})
// ── the hub: the session's updates PUSHED, instead of polled (greenhouse decisions/0508) ──────────────────
// The turn still runs through `docker exec`; what changed is how the Desktop learns what it does. The runtime
// publishes each session fact the moment it is stored — and the model's reasoning while it is still being
// written — to `milpa/sessions/<id>` on the hub (app-runtime BroadcastingEventStore, decisions/0190). main holds
// ONE subscription, for the session the renderer is driving, and forwards every update to the renderer.
//
// THE KEY STAYS IN THE CONTAINER. The subscriber JWT is signed inside it with the key the entrypoint minted for
// this container, and it names exactly one topic: the Desktop holds a pass to one session's feed, not the key.
// The stream is the truth and the hub is its doorbell: a missed update is recovered by reading the stream, so
// the renderer reads it on every update that is not reasoning, and falls back to polling if the hub goes away.
const http = require('node:http')
let hubSub = null   // { session, req, closed }
const SUBSCRIBER_JWT = '$s=json_decode((string) @file_get_contents(".milpa/secrets.json"), true);$k=$s["workspace"]["mercure"]["subscriber_key"] ?? "";' +
  'if (!is_string($k) || $k === "") { exit(3); }$b=fn($x)=>rtrim(strtr(base64_encode($x), "+/", "-_"), "=");' +
  '$h=$b(json_encode(["alg"=>"HS256","typ"=>"JWT"]));$p=$b(json_encode(["mercure"=>["subscribe"=>[$argv[1]]],"exp"=>time()+86400]));' +
  'echo $h, ".", $p, ".", $b(hash_hmac("sha256", "$h.$p", $k, true));'
function toRenderer (msg) { for (const w of BrowserWindow.getAllWindows()) { try { w.webContents.send('milpa:hub', msg) } catch {} } }
function closeHub () { if (hubSub) { hubSub.closed = true; try { hubSub.req.destroy() } catch {} hubSub = null } }
function openHub (sid, jwt, attempt) {
  const topic = 'milpa/sessions/' + sid
  const sub = { session: sid, closed: false, req: null }
  const url = new URL(`${BASE}/.well-known/mercure`); url.searchParams.set('topic', topic)
  sub.req = http.get(url, { headers: { Authorization: `Bearer ${jwt}`, Accept: 'text/event-stream' } }, (res) => {
    if (res.statusCode !== 200) { res.resume(); if (!sub.closed) { sub.closed = true; toRenderer({ session: sid, closed: true, status: res.statusCode }) } return }
    toRenderer({ session: sid, open: true, reconnected: attempt > 0 })
    let buf = ''
    res.setEncoding('utf8')
    res.on('data', (chunk) => {
      buf += chunk
      let i
      while ((i = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, i); buf = buf.slice(i + 2)
        const data = block.split('\n').filter(l => l.startsWith('data:')).map(l => l.slice(5).replace(/^ /, '')).join('\n')
        if (!data) continue
        try { toRenderer({ session: sid, update: JSON.parse(data) }) } catch {}
      }
    })
    // A hub may close a long-lived stream (a write timeout, a restart). Reconnect a few times before telling
    // the renderer to fall back; each reconnect is a doorbell of its own, since updates may have been missed.
    res.on('end', () => reconnect())
    res.on('error', () => reconnect())
  })
  sub.req.on('error', () => reconnect())
  const reconnect = () => {
    if (sub.closed || hubSub !== sub) return
    sub.closed = true
    if (attempt >= 3) { hubSub = null; toRenderer({ session: sid, closed: true }); return }
    setTimeout(() => { if (hubSub === sub) { hubSub = openHub(sid, jwt, attempt + 1) } }, 500 * (attempt + 1))
  }
  return sub
}
handle('milpa:subscribe', async (_e, { session: sid } = {}) => {
  const s = String(sid || 'default')
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(s)) return { live: false, reason: 'session id is not a topic' }
  if (!HUB) return { live: false, reason: 'no hub on this backend', server: SERVER }
  if (hubSub && hubSub.session === s && !hubSub.closed) return { live: true, session: s }
  closeHub()
  const { err, out } = await exec('docker', ['exec', NAME, 'php', '-r', SUBSCRIBER_JWT, '--', 'milpa/sessions/' + s])
  const jwt = (out || '').trim()
  if (err || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(jwt)) return { live: false, reason: 'the backend holds no subscriber key' }
  hubSub = openHub(s, jwt, 0)
  return { live: true, session: s }
})
handle('milpa:unsubscribe', async () => { closeHub(); return { ok: true } })

// ── identity / key custody (greenhouse decisions/0611, supersedes 0121) ──────────────────────────────────────────
// The person's key lives on the HOST and never enters the container (host-signer.js). So `keys` lists the HOST
// keyring for custody, and `keygen` creates the key on the HOST, then gives the container only the PUBLIC key to
// verify with. Signing itself (`signOp`, `enableCapability`) stays `docker exec … --sign`: inside the container the
// `--sign` gate now routes through RemoteOperationSigner → the socket → here, where the person approves and the host
// signs. NO `gpg --card-status` in the container — the card is a host concern now (and the mount that reached it is
// gone); a card's touch, when there is one, reaches the person at the host signer's own gpg.
const listKeys = (out) => {
  const keys = []; let fpr = null
  for (const l of (out || '').split('\n')) {
    if (l.startsWith('sec')) fpr = null
    else if (l.startsWith('fpr') && !fpr) { fpr = l.split(':')[9]; keys.push({ fingerprint: fpr, uid: '' }) }
    else if (l.startsWith('uid') && keys.length) keys[keys.length - 1].uid = l.split(':')[9]
  }
  return keys
}
handle('milpa:keys', async () => {
  const { out } = await exec('gpg', ['--list-secret-keys', '--with-colons'], { env: { ...process.env, GNUPGHOME: HOST_GNUPG } })
  const keys = listKeys(out)
  return { ok: true, keys, custody: keys.length ? 'software' : 'none' }
})
// «Crear claves»: generate a software gpg key on the HOST keyring (0611) — the private key is born on the host and
// never enters the container — make it the host's default signing key, and give the container the public key to verify.
handle('milpa:keygen', async (_e, { name, email } = {}) => {
  const real = (name || 'Milpa Operator').replace(/[\r\n"]/g, '')
  const mail = (email || 'operator@milpa.local').replace(/[\r\n"]/g, '')
  const params = `%no-protection\nKey-Type: eddsa\nKey-Curve: ed25519\nKey-Usage: sign\nName-Real: ${real}\nName-Email: ${mail}\nExpire-Date: 0\n%commit\n`
  try { fs.mkdirSync(HOST_GNUPG, { recursive: true, mode: 0o700 }) } catch {}
  const env = { ...process.env, GNUPGHOME: HOST_GNUPG }
  // gpg --gen-key reads the param block on stdin, which async execFile cannot feed; execFileSync can. ed25519 is fast.
  try { execFileSync('gpg', ['--batch', '--pinentry-mode', 'loopback', '--gen-key'], { input: params, env, stdio: ['pipe', 'ignore', 'ignore'] }) } catch (e) { return { ok: false, error: String(e && e.message || e) } }
  let out = ''
  try { out = execFileSync('gpg', ['--list-secret-keys', '--with-colons'], { env, encoding: 'utf8' }) } catch {}
  let fpr = null
  for (const l of (out || '').split('\n')) { if (l.startsWith('fpr')) { fpr = l.split(':')[9]; break } }
  // Make it the host's default signing key. No `batch`/loopback forced globally — the host signer must be able to ask
  // the person for a passphrase or a card touch (host-signer.js runs gpg without --batch).
  if (fpr) { try { fs.appendFileSync(path.join(HOST_GNUPG, 'gpg.conf'), `default-key ${fpr}\n`) } catch {} }
  // Give the container the PUBLIC key so it can verify this signer; the private key stays on the host.
  try { signWiring.provisionPublicKeyring({ container: NAME, hostGnupg: HOST_GNUPG }) } catch {}
  return { ok: !!fpr, fingerprint: fpr }
})
// Run a signed identity operation (identity:bootstrap / identity:enroll / identity:revoke / session:own). The `--sign`
// inside the container routes through the host signer (0611); the renderer only names the op and args.
handle('milpa:signOp', async (_e, { op, args } = {}) => {
  const allow = ['identity:bootstrap', 'identity:enroll', 'identity:revoke', 'session:own']
  if (!allow.includes(op)) return { ok: false, error: `refused: ${op} is not a signable identity op` }
  const flags = []
  for (const [k, v] of Object.entries(args || {})) {
    if (Array.isArray(v)) for (const item of v) flags.push(`--${k}=${item}`)
    else flags.push(`--${k}=${v}`)
  }
  const { err, out } = await exec('docker', ['exec', NAME, 'php', 'bin/coa', op, ...flags, '--sign', '--json'])
  try { const d = JSON.parse(out.trim().split('\n').filter(Boolean).pop()); return d.result || d } catch { return { ok: !err, raw: (out || String(err)).slice(-2000) } }
})
// ── a security key that asks for a PIN (greenhouse decisions/0568) ──────────────────────────────────────────────
// The house requires user verification, a key without a fingerprint reader gives it by PIN, and the PIN is asked by
// the client — which Electron's Chromium is not (evidence/1100; still so in Electron 44). So the Desktop is: it talks
// to the key and asks for the PIN in its own window. One channel, for the top frame of a page of this house, giving
// what `navigator.credentials` gives; it is not the bridge above, and it is refused to everybody else.
require('./security-key/desk.js').attach({ ipcMain, BrowserWindow, house: PASSKEY_ORIGIN, root: __dirname })

// ── capabilities: what the app can do, and enabling more (a signed, app-changing act) ────────────
handle('milpa:capabilities', async () => {
  const { out } = await exec('docker', ['exec', NAME, 'php', 'bin/coa', 'capabilities', '--json'])
  try { const d = JSON.parse(out.trim().split('\n').filter(Boolean).pop()); return d.result || d } catch { return { ok: false } }
})
handle('milpa:skills', async () => {
  // The skills this app carries, projected by the governed read `skill:list`. The renderer shows
  // them; it never reads the filesystem or decides invocation — the backend owns that (decisions/0172).
  const { out } = await exec('docker', ['exec', NAME, 'php', 'bin/coa', 'skill:list', '--json'])
  try { const d = JSON.parse(out.trim().split('\n').filter(Boolean).pop()); return d.result || d } catch { return { ok: false, skills: [] } }
})
handle('milpa:roles', async () => {
  // The specialist agent roles this app declares, projected by `agent:role:list`. The renderer shows
  // each role with the skills it preloads; the backend owns the roles, the renderer only projects.
  const { out } = await exec('docker', ['exec', NAME, 'php', 'bin/coa', 'agent:role:list', '--json'])
  try { const d = JSON.parse(out.trim().split('\n').filter(Boolean).pop()); return d.result || d } catch { return { ok: false, roles: [] } }
})
handle('milpa:catalogue', async () => {
  // The op catalogue an agent receives from this app, each tool carrying its DECLARED effect
  // (mutating, requiresConfirmation, effects). The tool cards read the mutation from HERE — the
  // authoritative declaration — instead of guessing it from the tool name (a read op like
  // artifact:contract was being mislabelled «mutante»). The backend owns the effect; the renderer
  // only projects what the operation declared.
  const { out } = await exec('docker', ['exec', NAME, 'php', 'bin/coa', 'agent:catalogue', '--json'])
  try { const d = JSON.parse(out.trim().split('\n').filter(Boolean).pop()); return d.result || d } catch { return { ok: false, tools: [] } }
})
handle('milpa:declareRole', async (_e, input) => {
  // Compose a specialist agent through the governed operation `agent:role:declare`. The human runs it
  // directly (the terminal is the honest, ungated channel); it writes .milpa/agents/<name>.md.
  const i = input || {}
  const csv = (a) => Array.isArray(a) ? a.join(',') : String(a || '')
  const args = ['exec', NAME, 'php', 'bin/coa', 'agent:role:declare', `--name=${String(i.name || '')}`, `--prompt=${String(i.prompt || '')}`, '--json']
  if (csv(i.skills)) args.push(`--skills=${csv(i.skills)}`)
  if (csv(i.deny)) args.push(`--deny=${csv(i.deny)}`)
  if (i.produces) args.push(`--produces=${String(i.produces)}`)
  const { out } = await exec('docker', args)
  try { const d = JSON.parse(out.trim().split('\n').filter(Boolean).pop()); return d.result || d } catch { return { ok: false, error: 'declare failed' } }
})
handle('milpa:enableCapability', async (_e, capability) => {
  const cap = String(capability || '').replace(/[^a-zA-Z0-9/_.-]/g, '')
  if (!cap) return { ok: false, error: 'bad capability' }
  const { err, out } = await exec('docker', ['exec', NAME, 'php', 'bin/coa', 'capabilities:enable', `--capability=${cap}`, '--sign', '--json'])
  try { const d = JSON.parse(out.trim().split('\n').filter(Boolean).pop()); return d.result || d } catch { return { ok: !err, raw: (out || String(err)).slice(-2000) } }
})
handle('milpa:status', async () => ({ model: MODEL, version: VERSION, backend: BOOT.phase === 'up', base: BASE, image: IMAGE, server: SERVER, hub: HUB, trial: TRIAL }))

// ── the window: the boot screen, then the house's panel (greenhouse evidence/1091, E3) ─────────────────────────────
// What the boot screen reads: where the house is, whether it serves its panel yet, and the commands that give it one
// — printed with the `docker exec` they are typed with here (E5), because the boot screen is the Desktop's own page.
// THE FOUNDING COMMAND IS NOT PRINTED HERE (greenhouse decisions/0566). It was, as `foundation:found --domain="…"
// --objective="…" --sign`; Rod copied it as it stood and the house was founded with «…» — and a constitution is
// written once (evidence/1100). The boot screen gets `run`, how a command starts here, and composes the founding
// command from what the person types into two fields: until both say something there is no command to copy.
handle('milpa:boot', async () => {
  if (BOOT.phase === 'up' && !BOOT.panel) BOOT.panel = await panelServed()
  const run = `${TERMINAL} php bin/coa`
  return {
    ...BOOT, origin: PASSKEY_ORIGIN, panelUrl: SIGNIN_URL, keyPin: KEY_PIN, container: BOOT.phase === 'starting' ? null : NAME, image: IMAGE, server: SERVER,
    commands: { run, panel: `${run} capabilities:enable milpa/admin --sign` },
  }
})
// Open a link of THIS house in the window — the one-time link the panel's enablement printed, or the panel itself.
// Any other origin is refused here, whatever the boot screen already said.
const notThisHouse = { ok: false, error: `refused: not a link of this house (${PASSKEY_ORIGIN})` }
handle('milpa:openInWindow', async (_e, url) => {
  const target = openWhere.linkOfThisHouse(url, PASSKEY_ORIGIN)
  if (!target) return notThisHouse
  BOOT.phase = 'opening'
  win.loadURL(target.href)
  return { ok: true }
})
// …or in the person's browser — the other door, and the one for a key with a PIN where the Desktop cannot ask for it.
// The same check: only a link of this house is handed to the system. The window stays on the boot screen.
handle('milpa:openInBrowser', async (_e, url) => {
  const target = openWhere.linkOfThisHouse(url, PASSKEY_ORIGIN)
  if (!target) return notThisHouse
  openWhere.remember(app.getPath('userData'), 'browser')
  try { await shell.openExternal(target.href); return { ok: true } } catch (e) { return { ok: false, error: String(e && e.message || e).split('\n')[0] } }
})
// The window stays on this house. A link elsewhere (a resident's blog post linking out, a doc) opens in the person's
// browser; a popup of this house opens as a child window, an http page the bridge is never exposed to.
function keepOnTheHouse (w) {
  const ours = (u) => { try { const o = new URL(u); return o.origin === PASSKEY_ORIGIN || o.protocol === 'file:' } catch { return false } }
  w.webContents.on('will-navigate', (e, u) => { if (!ours(u)) { e.preventDefault(); shell.openExternal(u) } })
  w.webContents.setWindowOpenHandler(({ url: u }) => {
    if (!ours(u)) { shell.openExternal(u); return { action: 'deny' } }
    return { action: 'allow', overrideBrowserWindowOptions: { autoHideMenuBar: true, webPreferences: { ...HOUSE_PAGE, contextIsolation: true, nodeIntegration: false } } }
  })
}

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)   // no native File/Edit/View menu — it means nothing for this app
  // THE WINDOW FIRST, the house after: the person sees the Desktop start at once, and sees it fail if it fails.
  win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1024, minHeight: 680,
    title: 'Milpa Desktop', backgroundColor: '#17120D',
    webPreferences: { ...HOUSE_PAGE, contextIsolation: true, nodeIntegration: false },
  })
  keepOnTheHouse(win)
  // The window is remembered as the place for the panel once the panel is IN it — a sign-in finished here — not when
  // it was merely asked for: a sign-in that did not finish here must not become the next launch's dead end (decisions/0566).
  win.webContents.on('did-navigate', (_e, url) => { if (openWhere.isThePanel(url, PANEL_URL)) openWhere.remember(app.getPath('userData'), 'window') })
  win.loadFile(path.join(__dirname, 'renderer', 'boot.html'))
  try {
    await startBackend()
    BOOT.phase = 'up'
    BOOT.panel = await panelServed()
    // A house that already serves its panel (MILPA_KEEP_BACKEND, a restart of the window) opens it straight away FOR
    // SOMEBODY WHO CHOSE THIS WINDOW BEFORE. Anybody else stays on the boot screen, which offers the browser and the
    // window (greenhouse decisions/0566).
    if (openWhere.opensTheWindowAtLaunch(openWhere.recall(app.getPath('userData')), BOOT.panel)) { BOOT.phase = 'opening'; win.loadURL(SIGNIN_URL) }
  } catch (e) {
    BOOT.phase = 'failed'
    BOOT.error = String(e && e.message || e).split('\n')[0]
  }
  // Open maximized — a workspace, not a small dialog. The 1440×900 size above is the RESTORED size
  // (what you get when you un-maximize), so it still behaves on small screens.
  win.maximize()
  // The menu is gone, and the window shows a web page: it keeps the keys a browser answers to — reload (Ctrl/Cmd+R,
  // F5), back and forward (Alt+Left/Right), devtools (Ctrl/Cmd+Shift+I) — and a right-click menu that names them
  // (greenhouse decisions/0563). The page is handed nothing: this is chrome of the window.
  require('./window-chrome.js').attach(win, { Menu, shell })

  if (process.env.MILPA_CAPTURE) {
    win.webContents.on('did-finish-load', async () => {
      await new Promise(r => setTimeout(r, 2000))
      if (process.env.MILPA_QUERY) {
        const q = JSON.stringify(process.env.MILPA_QUERY)
        await win.webContents.executeJavaScript(`document.querySelector('#auth-open') && !document.querySelector('#auth-open').disabled && document.querySelector('#auth-open').click()`)
        await new Promise(r => setTimeout(r, 500))
        await win.webContents.executeJavaScript(`(()=>{const t=document.querySelector('#query');t.value=${q};document.querySelector('#send').click();})()`)
        await new Promise(r => setTimeout(r, 60000)) // let the agent turn complete + render
        if (process.env.MILPA_TAB) { await win.webContents.executeJavaScript('document.querySelector(\'[data-tab="' + process.env.MILPA_TAB + '"]\')?.click()'); await new Promise(r => setTimeout(r, 800)) }
      }
      const img = await win.webContents.capturePage()
      require('node:fs').writeFileSync(process.env.MILPA_CAPTURE, img.toPNG())
      stopBackend(); app.quit()
    })
  }

  // Headless E2E of the hosted REMOTE component against the REAL container: enter the app, open the
  // Components screen (which fetches GET /live/page from the container), and drive a sort — its action
  // round-trips over the bridge to POST /live and the server re-signs. Prints one E2E line, then quits.
  if (process.env.MILPA_E2E_COMPONENT) {
    const nap = ms => new Promise(r => setTimeout(r, ms))
    win.webContents.on('did-finish-load', async () => {
      const js = c => win.webContents.executeJavaScript(c)
      try {
        await nap(3500)
        await js("document.querySelector('#auth-open') && document.querySelector('#auth-open').click()"); await nap(1200)
        await js("var n=document.querySelector('[data-nav=\"componentes\"]'); n && n.click()"); await nap(3000)
        const r = await js("(async () => {" +
          "  const host = document.querySelector('#component-host');" +
          "  const root = host && host.querySelector('[x-data^=\"milpaDataTable\"]');" +
          "  const nonceOf = () => { const s = host && host.querySelector('script[data-milpa-state]'); return s ? ((s.textContent||'').match(/sig-nonce=\"([0-9a-f]+)\"/)||[])[1] : null; };" +
          "  if (!root) return { hosted:false, snippet:(host?host.innerHTML.slice(0,160):'no host') };" +
          "  let data; try { data = window.Alpine.$data(root); } catch(e){ return { hosted:true, hydrated:false, err:String(e) }; }" +
          "  const remote = ('busy' in data); const before = nonceOf();" +
          "  try { await data.sort('deal'); } catch(e) {}" +
          "  const deadline = Date.now()+6000; let after = before;" +
          "  while (Date.now()<deadline){ await new Promise(r=>setTimeout(r,150)); const n=nonceOf(); if(n&&n!==before){after=n;break;} }" +
          "  return { hosted:true, hydrated:true, remote, before, after, roundTripped: !!(after&&after!==before), err: data.error };" +
          "})()")
        process.stdout.write('E2E ' + JSON.stringify(r) + '\n')
        if (process.env.MILPA_E2E_SHOT) { try { require('node:fs').writeFileSync(process.env.MILPA_E2E_SHOT, (await win.webContents.capturePage()).toPNG()) } catch {} }
      } catch (e) { process.stdout.write('E2E ' + JSON.stringify({ error: String(e) }) + '\n') }
      stopBackend(); app.quit()
    })
  }

  // Headless E2E of the AGENT WEB CHANNEL (greenhouse decisions/0155): with MILPA_AGENT_HTTP_ONLY set,
  // the agent path has NO docker-exec fallback — so if the Desktop still reads the session, it reached
  // the container's agent door over HTTP, the same web surface the component uses. Electron = web host.
  if (process.env.MILPA_E2E_AGENT) {
    const nap = ms => new Promise(r => setTimeout(r, ms))
    win.webContents.on('did-finish-load', async () => {
      const js = c => win.webContents.executeJavaScript(c)
      try {
        await nap(3500)
        const r = await js("(async () => { const s = await window.milpa.show('default'); return { ok: !!(s && s.ok !== false), goal: (s && (s.goal||s.mode)) || null, turns: (s && s.turns) || null, err: (s && s.error) || null }; })()")
        process.stdout.write('E2E-AGENT ' + JSON.stringify(Object.assign({ httpOnly: AGENT_HTTP_ONLY }, r)) + '\n')
      } catch (e) { process.stdout.write('E2E-AGENT ' + JSON.stringify({ error: String(e) }) + '\n') }
      stopBackend(); app.quit()
    })
  }
})
app.on('window-all-closed', () => { stopBackend(); app.quit() })
app.on('before-quit', stopBackend)
