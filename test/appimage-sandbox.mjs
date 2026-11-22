// Apache-2.0 · (c) Rodrigo Vicente - TeamX Agency
// Inspect and run the exact Linux release artifact. No source-app substitution or sandbox fallback.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { execFileSync } from 'node:child_process'
import { spawnOwned, stopOwned, installSignalCleanup } from './owned-processes.mjs'
import { pathToFileURL } from 'node:url'

const delay = ms => new Promise(resolve => setTimeout(resolve, ms))
const sha256 = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex')
const demand = (condition, message) => { if (!condition) throw new Error(message) }

export function desktopArguments (text) {
  // electron-builder's AppImage launcher has this deliberately narrow grammar. Fail closed on changes.
  const lines = text.split(/\r?\n/).filter(line => line.startsWith('Exec='))
  demand(lines.length === 1, 'Expected one desktop Exec entry')
  const match = /^Exec=AppRun((?: --[a-zA-Z0-9-]+)*) %U$/.exec(lines[0])
  demand(match, 'Unsupported desktop Exec entry')
  return match[1].trim().split(/\s+/).filter(Boolean)
}

export function sandboxActive (browser, renderer) {
  // Seccomp/NoNewPrivs alone may come from the runner. Chromium must add its own filter and PID namespace.
  return browser.uid !== 0 && renderer.uid === browser.uid && renderer.noNewPrivs === 1 &&
    renderer.seccomp === 2 && renderer.filters > browser.filters && renderer.capEff === '0000000000000000' &&
    renderer.nsPids.length > browser.nsPids.length
}

function processState (pid) {
  demand(Number.isInteger(pid) && pid > 0, 'Invalid process identity')
  const fields = Object.fromEntries(fs.readFileSync(`/proc/${pid}/status`, 'utf8').trim().split('\n').map(line => {
    const at = line.indexOf(':'); return [line.slice(0, at), line.slice(at + 1).trim()]
  }))
  for (const key of ['Uid', 'NSpid', 'NoNewPrivs', 'Seccomp', 'Seccomp_filters', 'CapEff']) demand(key in fields, `Missing kernel field ${key}`)
  const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8')
  return { pid, starttime: stat.slice(stat.lastIndexOf(')') + 2).split(' ')[19], uid: Number(fields.Uid.split(/\s+/)[0]),
    nsPids: fields.NSpid.split(/\s+/).map(Number), noNewPrivs: Number(fields.NoNewPrivs),
    seccomp: Number(fields.Seccomp), filters: Number(fields.Seccomp_filters), capEff: fields.CapEff }
}

async function inspector (url) {
  const ws = new WebSocket(url)
  await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { ws.close(); reject(new Error('Inspector connection timeout')) }, 5000)
    ws.onopen = () => { clearTimeout(timer); resolve() }
    ws.onerror = () => { clearTimeout(timer); reject(new Error('Inspector connection failed')) }
  })
  let serial = 0
  const pending = new Map()
  ws.onmessage = event => {
    const message = JSON.parse(event.data); const item = pending.get(message.id)
    if (!item) return
    pending.delete(message.id); clearTimeout(item.timer)
    message.error ? item.reject(new Error(JSON.stringify(message.error))) : item.resolve(message.result)
  }
  return {
    close: () => ws.close(),
    call: (method, params) => new Promise((resolve, reject) => {
      const id = ++serial
      const timer = setTimeout(() => { pending.delete(id); reject(new Error('Inspector request timeout')) }, 5000)
      pending.set(id, { resolve, reject, timer }); ws.send(JSON.stringify({ id, method, params }))
    }),
  }
}

const observation = `globalThis.__milpaSandboxObservation = (async () => {
  const { app, BrowserWindow } = process.mainModule.require('electron');
  const windows = BrowserWindow.getAllWindows();
  if (windows.length !== 1 || windows[0].webContents.isLoading() || !windows[0].webContents.getURL().endsWith('/renderer/boot.html')) return null;
  const w = windows[0], c = w.webContents, pid = c.getOSProcessId();
  const boot = await c.executeJavaScript('(async()=>({url:location.href,title:document.title,ready:document.readyState,bridge:typeof window.milpa?.boot,boot:await window.milpa?.boot()}))()');
  if (pid !== c.getOSProcessId()) throw new Error('Renderer changed during observation');
  return { mainPid:process.pid, rendererPid:pid, argv:process.argv, electron:process.versions.electron,
    appPath:app.getAppPath(), visible:w.isVisible(), preferences:c.getLastWebPreferences(), boot };
})()`

async function launch (image, args, route, root) {
  const home = path.join(root, route); fs.mkdirSync(home)
  const bin = path.join(home, 'bin'); fs.mkdirSync(bin)
  const stubLog = path.join(home, 'docker-invoked')
  fs.writeFileSync(path.join(bin, 'docker'), '#!/bin/sh\nprintf "blocked\\n" >> "$HOME/docker-invoked"\nexit 69\n', { mode: 0o755 })
  const env = { PATH: `${bin}:${process.env.PATH}`, HOME: home, LANG: 'C.UTF-8',
    DISPLAY: process.env.DISPLAY, XAUTHORITY: process.env.XAUTHORITY,
    XDG_CONFIG_HOME: path.join(home, 'config'), XDG_CACHE_HOME: path.join(home, 'cache'), XDG_DATA_HOME: path.join(home, 'data'),
    MILPA_KEEP_BACKEND: '1', MILPA_BACKEND: 'sandbox-release-probe', MILPA_SECURITY_KEYS: path.join(home, 'absent-key'),
    DBUS_SESSION_BUS_ADDRESS: `unix:path=${home}/absent-bus` }
  // The standard inspector is observation-only here; no production test seam is shipped.
  const commandArgs = [...args, '--inspect=127.0.0.1:0', `--user-data-dir=${home}/user-data`]
  let command = image, argv = commandArgs
  if (route === 'desktop') {
    demand(!image.includes('"') && !image.includes('%') && !image.includes('\\'), 'Unsupported AppImage path')
    const entry = path.join(home, 'probe.desktop')
    // Preserve the embedded launcher's arguments, substitute only its installed executable and observation flags.
    fs.writeFileSync(entry, `[Desktop Entry]\nType=Application\nName=Milpa sandbox probe\nExec="${image}" ${commandArgs.map(a => '"' + a + '"').join(' ')}\nTerminal=false\n`)
    command = 'gio'; argv = ['launch', entry]
  }
  const child = spawnOwned(command, argv, { env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] })
  let logs = '', spawnError, client
  const collect = chunk => { logs = (logs + chunk).slice(-131072) }
  child.stdout.on('data', collect); child.stderr.on('data', collect); child.on('error', error => { spawnError = error })
  const deadline = Date.now() + 25000
  try {
    let url
    while (Date.now() < deadline) {
      if (spawnError) throw spawnError
      url = logs.match(/Debugger listening on (ws:\/\/127\.0\.0\.1:\d+\/[^\s]+)/)?.[1]
      if (url) break
      await delay(100)
    }
    demand(url, 'Packaged application did not expose its inspector (no sandbox fallback permitted)')
    client = await inspector(url)
    let observed
    while (Date.now() < deadline) {
      const response = await client.call('Runtime.evaluate', { expression: observation, awaitPromise: true, returnByValue: true })
      if (!response.exceptionDetails && response.result?.value?.boot?.ready === 'complete') { observed = response.result.value; break }
      await delay(100)
    }
    demand(observed?.visible && observed.boot.bridge === 'function' && observed.boot.title === 'Milpa Desktop', 'The real application window/bridge did not load')
    demand(observed.boot.url.endsWith('/resources/app.asar/renderer/boot.html'), 'Unexpected application page')
    demand(observed.boot.boot.phase === 'failed' && fs.existsSync(stubLog), 'Backend isolation was not exercised')
    demand(observed.mainPid !== observed.rendererPid, 'Missing distinct renderer')
    const browser = processState(observed.mainPid), renderer = processState(observed.rendererPid)
    const confirm = await client.call('Runtime.evaluate', { expression: observation, awaitPromise: true, returnByValue: true })
    demand(confirm.result?.value?.rendererPid === renderer.pid && confirm.result.value.mainPid === browser.pid, 'Window process identity changed')
    demand(processState(browser.pid).starttime === browser.starttime && processState(renderer.pid).starttime === renderer.starttime, 'Process identity was reused')
    return { route, args, observed, browser, renderer, active: sandboxActive(browser, renderer) }
  } finally {
    client?.close()
    fs.writeFileSync(path.join(root, `${route}.log`), logs)
    await stopOwned(child.pid)
  }
}

export async function verify (file, output) {
  demand(process.platform === 'linux' && process.getuid() !== 0, 'Requires a non-root Linux runner')
  demand(typeof WebSocket === 'function', 'Requires Node.js 22 or newer')
  demand(process.env.DISPLAY, 'Requires an X display (run under xvfb-run in CI)')
  demand(!fs.readdirSync('/dev').some(name => name.startsWith('hidraw')), 'Run in an environment without physical security keys')
  const image = fs.realpathSync(file), hash = sha256(image), root = fs.mkdtempSync(path.join(os.tmpdir(), 'milpa-sandbox-'))
  const report = { schema: 1, environment: { kernel: os.release(), node: process.version, observer: processState(process.pid) }, artifact: path.basename(image), sha256: hash, mode: 'mounted-appimage', scope: 'boot-window renderer', cases: [] }
  try {
    const offset = execFileSync(image, ['--appimage-offset'], { timeout: 5000, encoding: 'utf8' }).trim()
    demand(/^\d+$/.test(offset), 'Invalid AppImage offset')
    const metadata = path.join(root, 'metadata')
    execFileSync('unsquashfs', ['-o', offset, '-d', metadata, '-no-progress', image, '*.desktop', 'AppRun'], { timeout: 15000, stdio: 'pipe' })
    const entries = fs.readdirSync(metadata).filter(name => name.endsWith('.desktop'))
    demand(entries.length === 1, 'Expected one packaged desktop entry')
    report.desktop = fs.readFileSync(path.join(metadata, entries[0]), 'utf8')
    report.appRunSha256 = sha256(path.join(metadata, 'AppRun'))
    const menuArgs = desktopArguments(report.desktop)
    // Run every arm before judging. A boot failure is an inconclusive failure, never a successful negative.
    for (const [route, args] of [['direct', []], ['desktop', menuArgs], ['disabled-control', ['--no-sandbox']]]) {
      report.cases.push(await launch(image, args, route, root))
    }
    demand(report.cases[0].active && report.cases[1].active, 'Sandbox inactive on a supported launch path')
    const negative = report.cases[2]
    demand(!negative.active && negative.renderer.seccomp === negative.browser.seccomp && negative.renderer.filters === negative.browser.filters && negative.renderer.nsPids.length === negative.browser.nsPids.length,
      'Disabled control did not demonstrate absence of Chromium renderer confinement')
    demand(sha256(image) === hash, 'Artifact changed during verification')
    report.passed = true
  } catch (error) {
    report.passed = false; report.error = error.message
  } finally {
    report.logs = Object.fromEntries(fs.readdirSync(root).filter(name => name.endsWith('.log')).map(name => [name, fs.readFileSync(path.join(root, name), 'utf8')]))
    fs.writeFileSync(output, JSON.stringify(report, null, 2) + '\n')
    fs.rmSync(root, { recursive: true, force: true })
  }
  return report
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  installSignalCleanup()
  const [file, output] = process.argv.slice(2)
  if (!file || !output) throw new Error('Usage: node test/appimage-sandbox.mjs APPIMAGE REPORT.json')
  const report = await verify(file, output)
  console.log(JSON.stringify({ artifact: report.artifact, sha256: report.sha256, passed: report.passed, error: report.error, cases: report.cases.map(c => ({ route: c.route, active: c.active })) }))
  process.exitCode = report.passed ? 0 : 1
}
