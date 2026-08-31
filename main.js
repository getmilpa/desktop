// Milpa Desktop — the Electron host. The renderer is a local milpa-designed UI; the backend is a milpa
// app in a Docker container. This main process owns what the renderer must never touch:
//   1. the container lifecycle       — `docker run` on ready, stop on quit;
//   2. the credential                — mint a Bearer via `coa token:new`, hold it here, inject it into
//                                       every request to the backend (the renderer stays credential-free);
//   3. driving the agent             — run `coa agent <query>` in the container against the configured model.
// The board's data is a session's private facts and is scope-protected (greenhouse evidence/0366-0370): the
// desktop host authenticates on the user's behalf. Model defaults to the local qwen (CLAUDE.md), overridable.
const { app, BrowserWindow, session, ipcMain, Menu } = require('electron')

// Native Wayland when the session is Wayland — XWayland's compositing can leave stale repaints (the
// conversation bleeding over the header/inspector). `ozone-platform-hint=auto` picks Wayland when it
// is there, which repaints cleanly; on X11 it is a no-op.
if (process.env.XDG_SESSION_TYPE === 'wayland' || process.env.WAYLAND_DISPLAY) {
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto')
}
// The ozone hint alone did NOT stop the stale repaints on this setup (the conversation ghosting over
// the header/inspector on scroll and re-hydration). Disable GPU COMPOSITING so layers composite in
// software — no stale GPU-composited tiles to leave behind. GPU rasterization stays; only the tile
// compositor changes, and for a text board the cost is nil. This is the reliable fix across X11,
// XWayland and native Wayland, so it is unconditional.
app.commandLine.appendSwitch('disable-gpu-compositing')
const { execFile, execFileSync } = require('node:child_process')
const path = require('node:path')
const os = require('node:os')
const fs = require('node:fs')

// KEY CUSTODY (greenhouse decisions/0121). The backend is an ephemeral container, so signing keys must
// live OUTSIDE it. Two paths, both wired: (a) a host GNUPGHOME mounted in as the default — software keys
// created here PERSIST on the host; (b) best-effort YubiKey passthrough via the host pcscd socket, so a
// smartcard's key is reachable without ever leaving the hardware. The container never holds a private key.
const HOST_GNUPG = process.env.MILPA_GNUPGHOME || path.join(os.homedir(), '.milpa', 'gnupg')
const PCSCD_SOCK = '/run/pcscd'  // host pcscd socket dir; mounted only when it exists (YubiKey present)
// PLATFORM. On Linux, `--network host` lets the container reach the local model and serves the board on
// the host directly. On macOS (and Windows), Docker runs in a VM where `--network host` binds the VM,
// NOT the host — so we publish the port instead, and a model on the Mac is reached via host.docker.internal.
const IS_MAC = process.platform === 'darwin'

// The distributable binary defaults to the PUBLIC dev image (pulled from ghcr, no clone, no auth): a downloaded
// Milpa Desktop is self-contained beyond needing Docker. House devs override with a local tag via MILPA_IMAGE
// (run-desktop.sh sets the graduated one).
const IMAGE = process.env.MILPA_IMAGE || 'ghcr.io/getmilpa/framework:dev'
const NAME = 'milpa-desktop-backend'
const HOST_PORT = process.env.MILPA_PORT || '8899'
const BASE = `http://127.0.0.1:${HOST_PORT}`
const MODEL = { base: process.env.MILPA_AGENT_BASE_URL || 'http://llama.local:11438', name: process.env.MILPA_AGENT_MODEL || 'qwen3.8-27b' }
let token = null
const VERSION = require('./package.json').version

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts }).trim()
const exec = (cmd, args, opts = {}) => new Promise((res) => {
  execFile(cmd, args, { encoding: 'utf8', maxBuffer: 1 << 24, ...opts }, (err, out) => res({ err, out: out || '' }))
})

async function startBackend () {
  try { sh('docker', ['rm', '-f', NAME]) } catch {}
  // --network host so the container can reach the local model (llama.local); the board is served on HOST_PORT.
  try { fs.mkdirSync(HOST_GNUPG, { recursive: true, mode: 0o700 }) } catch {}
  const mounts = ['-v', `${HOST_GNUPG}:/root/.gnupg`]
  // YubiKey passthrough is best-effort: mount the host pcscd socket only when it is there, so a machine
  // without a smartcard reader still launches. Real device access may need the host's udev rules too.
  try { if (fs.existsSync(PCSCD_SOCK)) mounts.push('-v', `${PCSCD_SOCK}:/run/pcscd`) } catch {}
  // On Linux, host networking; on macOS, publish the port (host networking is a no-op in the VM there).
  const net = IS_MAC ? ['-p', `${HOST_PORT}:${HOST_PORT}`] : ['--network', 'host']
  // The model config goes on the CONTAINER (not just per docker-exec), so the agent web door
  // (POST /agent over HTTP, greenhouse decisions/0155) reaches the local model too.
  const modelEnv = ['-e', `MILPA_AGENT_BASE_URL=${MODEL.base}`, '-e', `MILPA_AGENT_MODEL=${MODEL.name}`, '-e', 'MILPA_AGENT_BASIC_AUTH=']
  sh('docker', ['run', '-d', '--name', NAME, ...net, '-e', `PORT=${HOST_PORT}`, ...modelEnv, ...mounts, IMAGE,
    'php', '-S', `0.0.0.0:${HOST_PORT}`, '-t', 'public', 'public/index.php'])
  for (let i = 0; i < 40; i++) { try { const r = await fetch(`${BASE}/`); if (r.status < 500) break } catch {} await new Promise(r => setTimeout(r, 800)) }
  // The live door is governed: an action needs a milpa:component:<name>:<action> scope, and the
  // component segment is NOT covered by '*' (greenhouse decisions/0149). Grant the hosted components
  // explicitly so a hosted component's actions round-trip.
  try { const out = sh('docker', ['exec', NAME, 'php', 'bin/coa', 'token:new', '--actor=desktop', '--scopes=*', '--scopes=milpa:component:data-table:*', '--scopes=milpa:component:autocomplete:*', '--scopes=milpa:component:metric-card:*', '--scopes=milpa:component:state-machine:*', '--scopes=milpa:component:dashboard-grid:*', '--scopes=milpa:component:input:*', '--scopes=milpa:component:select:*', '--scopes=milpa:component:checkbox:*', '--scopes=milpa:component:textarea:*', '--scopes=agent:read', '--scopes=agent:answer', '--scopes=agent:run'])
        const m = out.match(/^token:\s*(\S+)/m); token = m ? m[1] : null } catch {}
}
function stopBackend () { try { sh('docker', ['rm', '-f', NAME]) } catch {} }

// ── IPC: the narrow bridge the preload exposes ─────────────────────────────────────────────────
ipcMain.handle('milpa:api', async (_e, p) => {
  try { const r = await fetch(`${BASE}${p}`, { headers: token ? { Authorization: `Bearer ${token}` } : {} })
        const text = await r.text(); try { return { ok: r.ok, status: r.status, json: JSON.parse(text) } } catch { return { ok: r.ok, status: r.status, text } } }
  catch (e) { return { ok: false, error: String(e) } }
})
// The agent over the WEB CHANNEL (greenhouse decisions/0155): the same HTTP surface the live door
// uses, not docker exec. main proxies these to the container's exposed agent operations with the
// Bearer; a founded app that does NOT expose them (config/http.php) falls back to docker exec so an
// unwired container still drives. This is what makes Electron a pure web-channel host.
// When set, the agent path is HTTP-only (no docker-exec fallback) — proves Electron talks the web
// channel to the agent, and is the honest mode once the container always exposes the door.
const AGENT_HTTP_ONLY = !!process.env.MILPA_AGENT_HTTP_ONLY
async function agentHttp (method, path, body) {
  const headers = Object.assign({ Accept: 'application/json' }, token ? { Authorization: `Bearer ${token}` } : {})
  if (body) headers['Content-Type'] = 'application/json'
  const r = await fetch(`${BASE}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined })
  const data = await r.json().catch(() => null)
  return { status: r.status, data }
}
ipcMain.handle('milpa:drive', async (_e, { query, session: sid }) => {
  const s = sid || 'default'
  try {
    const { status, data } = await agentHttp('POST', '/agent', { query, session: s, mode: 'ask' })
    if (status !== 404) { const r = (data && data.result) ? data.result : (data || {}); return { ok: status < 300 && r.ok !== false, session: s, answer: r.answer, steps: r.steps, tools: r.tools } }
  } catch {}
  if (AGENT_HTTP_ONLY) return { ok: false, session: s, answer: null, error: 'agent web door unreachable (http-only)' }
  // fallback: docker exec (unwired container)
  const { err, out } = await exec('docker',
    ['exec', '-e', `MILPA_AGENT_BASE_URL=${MODEL.base}`, '-e', `MILPA_AGENT_MODEL=${MODEL.name}`, '-e', 'MILPA_AGENT_BASIC_AUTH=',
     NAME, 'php', 'bin/coa', 'agent', query, `--session=${s}`, '--mode=ask', '--json'])
  let doc = null; try { doc = JSON.parse(out.trim().split('\n').filter(Boolean).pop()) } catch {}
  if (doc) { const r = (doc && doc.result) ? doc.result : doc; return { ok: r.ok !== false && !err, session: s, answer: r.answer, steps: r.steps, tools: r.tools } }
  const grab = (k) => (out.match(new RegExp(`^${k}:\\s*([\\s\\S]*?)(?=\\n\\w+:|$)`, 'm')) || [])[1]?.trim()
  return { ok: !err, session: s, answer: grab('answer'), steps: grab('steps'), tools: grab('tools'), raw: out.slice(-4000) }
})
ipcMain.handle('milpa:answer', async (_e, { session: sid, decision }) => {
  try {
    const { status, data } = await agentHttp('POST', '/agent/answer', { session: sid, answer: decision })
    if (status !== 404) return { ok: status < 300, out: JSON.stringify(data) }
  } catch {}
  if (AGENT_HTTP_ONLY) return { ok: false, out: 'agent web door unreachable (http-only)' }
  const { err, out } = await exec('docker', ['exec', NAME, 'php', 'bin/coa', 'agent:answer', `--session=${sid}`, `--answer=${decision}`, '--json'])
  return { ok: !err, out }
})
ipcMain.handle('milpa:show', async (_e, sid) => {
  const s = sid || 'default'
  try {
    const { status, data } = await agentHttp('GET', `/agent/show?session=${encodeURIComponent(s)}`)
    if (status !== 404 && data) return (data.result || data)
  } catch {}
  if (AGENT_HTTP_ONLY) return { ok: false, error: 'agent web door unreachable (http-only)' }
  const { out } = await exec('docker', ['exec', NAME, 'php', 'bin/coa', 'agent:show', `--session=${s}`, '--json'])
  try { const d = JSON.parse(out.trim().split('\n').filter(Boolean).pop()); return d.result || d } catch { return { ok: false } }
})
// Whether a DRIVING `coa agent` run is live in the container (only the driver carries --mode=ask; agent:show /
// agent:answer do not). On startup the renderer uses this to tell an INTERRUPTED prior run — tasks mid-flight,
// no agent process — from an ongoing one: killing the window kills the exec and leaves work half-done, and the
// UI must say so rather than look frozen. It does NOT auto-resume; Continuar is the user's verb (decisions/0132).
// Host a Milpa live web component: the container renders it framework-side (a signed <milpa-state> envelope +
// Alpine markup) and the shell hosts the HTML — a Desktop screen authored the Milpa way, not hand-written here
// (greenhouse decisions/0142). The per-app component route is wired by the container's live-web surface.
ipcMain.handle('milpa:component', async (_e, name) => {
  const n = encodeURIComponent(String(name || 'data-table'))
  // The framework's live door (milpa/app-runtime LivePlugin) serves the interactive render path at
  // GET /live/page?component=<name> — the page is born bound to this actor and immediately actionable
  // over POST /live (greenhouse decisions/0149, evidence/0412).
  try {
    const r = await fetch(`${BASE}/live/page?component=${n}`, token ? { headers: { Authorization: `Bearer ${token}` } } : {})
    if (r.ok) return { ok: true, html: await r.text() }
  } catch {}
  return { ok: false, error: 'live component surface not wired to this container (needs milpa/live-web + LivePlugin + a LivePageProvider)' }
})
// The bridge transport for a hosted live component: proxy the remote runtime's action POST to the
// container's live endpoint. The renderer's page is file://, so it cannot fetch the backend directly;
// main can. Returns { status, data } — exactly what window.MilpaLive.transport must resolve to.
ipcMain.handle('milpa:live', async (_e, { endpoint, body }) => {
  const url = /^https?:/.test(String(endpoint || '')) ? endpoint : `${BASE}${endpoint || '/live'}`
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: Object.assign({ 'Content-Type': 'application/json', Accept: 'application/json' }, token ? { Authorization: `Bearer ${token}` } : {}),
      body: JSON.stringify(body || {}),
    })
    let data = null; try { data = await r.json() } catch {}
    return { status: r.status, data }
  } catch (e) {
    return { status: 0, data: { error: 'live endpoint unreachable: ' + String(e && e.message || e) } }
  }
})
ipcMain.handle('milpa:stopAgent', async () => {
  // Interrupt an in-flight run so the user can steer with fresh context. Each turn is already persisted,
  // so killing the exec stops the loop without losing the work — Continue resumes from the last fact.
  try { await exec('docker', ['exec', NAME, 'pkill', '-f', 'bin/coa agent']) } catch {}
  return { ok: true }
})
ipcMain.handle('milpa:agentRunning', async () => {
  const { out } = await exec('docker', ['exec', NAME, 'sh', '-c', "pgrep -f 'coa agent .*--mode=ask' >/dev/null 2>&1 && echo yes || echo no"])
  return { running: /yes/.test(out) }
})
// Who the house recognizes as this session's owner right now — re-verified live by the backend
// (coa session:owner). The renderer PROJECTS this fact; it never decides it (greenhouse decisions/0120).
ipcMain.handle('milpa:owner', async (_e, sid) => {
  const { out } = await exec('docker', ['exec', NAME, 'php', 'bin/coa', 'session:owner', `--session=${sid || 'default'}`, '--json'])
  try { const d = JSON.parse(out.trim().split('\n').filter(Boolean).pop()); return d.result || d } catch { return { ok: false } }
})
// The session stream — model_called / tool_called / turn — read live so the UI streams the agent's work
// while `coa agent` is still running. php -S can't hold a long SSE connection, so the renderer polls this.
ipcMain.handle('milpa:events', async (_e, { session: sid, since }) => {
  const stream = 'agent-session:' + (sid || 'default')
  const { out } = await exec('docker', ['exec', NAME, 'sh', '-c',
    `grep -F '${stream.replace(/'/g, '')}' var/agent-sessions.jsonl 2>/dev/null || true`])
  const events = []
  for (const l of out.split('\n')) { if (!l) continue; try { const e = JSON.parse(l); if (e.stream_id === stream) events.push({ type: e.type, payload: e.payload || {} }) } catch {} }
  return { total: events.length, events: events.slice(Math.max(0, since || 0)) }
})
// ── identity / key custody (greenhouse decisions/0121) ──────────────────────────────────────────
// gpg runs INSIDE the container, but over the mounted host GNUPGHOME — so keys live on the host, never
// in the ephemeral backend. `keys` also reports whether a YubiKey/smartcard is reachable (card custody).
ipcMain.handle('milpa:keys', async () => {
  const { out } = await exec('docker', ['exec', NAME, 'gpg', '--list-secret-keys', '--with-colons'])
  const keys = []; let fpr = null
  for (const l of (out || '').split('\n')) {
    if (l.startsWith('sec')) fpr = null
    else if (l.startsWith('fpr') && !fpr) { fpr = l.split(':')[9]; keys.push({ fingerprint: fpr, uid: '' }) }
    else if (l.startsWith('uid') && keys.length) keys[keys.length - 1].uid = l.split(':')[9]
  }
  const card = await exec('docker', ['exec', NAME, 'gpg', '--card-status'])
  const hasCard = !!card.out && /Reader|Application ID|Serial number/i.test(card.out) && !/no.*card|not available/i.test(card.out)
  return { ok: true, keys, custody: hasCard ? 'yubikey' : (keys.length ? 'software' : 'none') }
})
// «Crear claves»: generate a software gpg key in the mounted GNUPGHOME (persists on the host), and make
// it the default signing key so `--sign` finds it without a key id.
ipcMain.handle('milpa:keygen', async (_e, { name, email } = {}) => {
  const real = (name || 'Milpa Operator').replace(/[\r\n"]/g, '')
  const mail = (email || 'operator@milpa.local').replace(/[\r\n"]/g, '')
  const params = `%no-protection\nKey-Type: eddsa\nKey-Curve: ed25519\nKey-Usage: sign\nName-Real: ${real}\nName-Email: ${mail}\nExpire-Date: 0\n%commit\n`
  const gen = await exec('docker', ['exec', '-i', NAME, 'gpg', '--batch', '--pinentry-mode', 'loopback', '--gen-key'], { input: params })
  if (gen.err) return { ok: false, error: String(gen.err) }
  const { out } = await exec('docker', ['exec', NAME, 'gpg', '--list-secret-keys', '--with-colons'])
  let fpr = null
  for (const l of (out || '').split('\n')) { if (l.startsWith('fpr')) { fpr = l.split(':')[9]; break } }
  if (fpr) await exec('docker', ['exec', NAME, 'sh', '-c', `printf 'default-key %s\nbatch\npinentry-mode loopback\n' '${fpr.replace(/[^0-9A-Fa-f]/g, '')}' >> /root/.gnupg/gpg.conf`])
  return { ok: !!fpr, fingerprint: fpr }
})
// Run a signed identity operation (identity:bootstrap / identity:enroll / identity:revoke / session:own).
// The signature happens in the container over the mounted keys; the renderer only names the op and args.
ipcMain.handle('milpa:signOp', async (_e, { op, args } = {}) => {
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
// ── capabilities: what the app can do, and enabling more (a signed, app-changing act) ────────────
ipcMain.handle('milpa:capabilities', async () => {
  const { out } = await exec('docker', ['exec', NAME, 'php', 'bin/coa', 'capabilities', '--json'])
  try { const d = JSON.parse(out.trim().split('\n').filter(Boolean).pop()); return d.result || d } catch { return { ok: false } }
})
ipcMain.handle('milpa:skills', async () => {
  // The skills this app carries, projected by the governed read `skill:list`. The renderer shows
  // them; it never reads the filesystem or decides invocation — the backend owns that (decisions/0172).
  const { out } = await exec('docker', ['exec', NAME, 'php', 'bin/coa', 'skill:list', '--json'])
  try { const d = JSON.parse(out.trim().split('\n').filter(Boolean).pop()); return d.result || d } catch { return { ok: false, skills: [] } }
})
ipcMain.handle('milpa:roles', async () => {
  // The specialist agent roles this app declares, projected by `agent:role:list`. The renderer shows
  // each role with the skills it preloads; the backend owns the roles, the renderer only projects.
  const { out } = await exec('docker', ['exec', NAME, 'php', 'bin/coa', 'agent:role:list', '--json'])
  try { const d = JSON.parse(out.trim().split('\n').filter(Boolean).pop()); return d.result || d } catch { return { ok: false, roles: [] } }
})
ipcMain.handle('milpa:declareRole', async (_e, input) => {
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
ipcMain.handle('milpa:enableCapability', async (_e, capability) => {
  const cap = String(capability || '').replace(/[^a-zA-Z0-9/_.-]/g, '')
  if (!cap) return { ok: false, error: 'bad capability' }
  const { err, out } = await exec('docker', ['exec', NAME, 'php', 'bin/coa', 'capabilities:enable', `--capability=${cap}`, '--sign', '--json'])
  try { const d = JSON.parse(out.trim().split('\n').filter(Boolean).pop()); return d.result || d } catch { return { ok: !err, raw: (out || String(err)).slice(-2000) } }
})
ipcMain.handle('milpa:status', async () => ({ model: MODEL, version: VERSION, backend: !!token, base: BASE }))

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)   // no native File/Edit/View menu — it means nothing for this app
  await startBackend()
  session.defaultSession.webRequest.onBeforeSendHeaders((details, cb) => {
    if (token && details.url.startsWith(BASE)) details.requestHeaders['Authorization'] = `Bearer ${token}`
    cb({ requestHeaders: details.requestHeaders })
  })
  const win = new BrowserWindow({
    width: 1440, height: 900, minWidth: 1024, minHeight: 680,
    title: 'Milpa Desktop', backgroundColor: '#17120D',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true, nodeIntegration: false },
  })
  win.loadFile(path.join(__dirname, 'renderer', 'index.html'))
  // The menu is gone, but keep the two shortcuts that matter: reload (Ctrl/Cmd+R) and devtools
  // (Ctrl/Cmd+Shift+I). Copy/paste in inputs is handled by Chromium without a menu.
  win.webContents.on('before-input-event', (e, input) => {
    if (input.type !== 'keyDown') return
    const mod = input.control || input.meta
    if (mod && !input.shift && input.key.toLowerCase() === 'r') win.webContents.reload()
    else if (mod && input.shift && input.key.toLowerCase() === 'i') win.webContents.toggleDevTools()
  })

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
