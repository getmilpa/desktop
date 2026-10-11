// DOES A DESKTOP HOUSE SURVIVE A RESTART? (greenhouse decisions/0611 review — the migration text depends on it.)
//
// main.js boots the house in a Docker container with NO volume, and stopBackend() does `docker rm -f` on quit; worse,
// startBackend() does `docker rm -f` at the START of every normal launch. So the question, by execution: after a
// normal launch → found → quit → relaunch, is the house still founded or NEW? And with MILPA_KEEP_BACKEND=1?
//
// This drives the REAL Desktop (electron main.js) under xvfb, twice per case, fully isolated: a throwaway HOME (so
// userData and ~/.milpa are lab dirs, never Rod's), a lab image pinned by id, a lab container name and port. It writes
// a marker into the house's state dir (/app/.milpa — where foundation.json is written) and checks whether it survives.
//   usage: xvfb-run -a node test/persist-measure.mjs <electron-binary> <image-id> [port]

import { spawn, execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const [ELECTRON, IMAGE, PORT = '8921'] = process.argv.slice(2)
const NAME = 'milpa-0611-persist'
const LABHOME = fs.mkdtempSync(path.join(os.tmpdir(), 'persist.'))
const MARKER = '.milpa/persist-marker' // relative to /app (the house's cwd)

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const docker = (args, opts = {}) => { try { return execFileSync('docker', args, { encoding: 'utf8', ...opts }) } catch (e) { return String((e && e.stdout) || (e && e.message) || e) } }
const running = () => docker(['ps', '--filter', `name=^${NAME}$`, '--format', '{{.Names}}']).trim() === NAME
const rmf = () => { try { execFileSync('docker', ['rm', '-f', NAME], { stdio: ['ignore', 'ignore', 'ignore'] }) } catch {} }

function launch (extraEnv) {
  const env = {
    ...process.env,
    HOME: LABHOME,
    XDG_CONFIG_HOME: path.join(LABHOME, '.config'),
    XDG_CACHE_HOME: path.join(LABHOME, '.cache'),
    MILPA_IMAGE: IMAGE,
    MILPA_BACKEND: NAME,
    MILPA_PORT: PORT,
    ...extraEnv,
  }
  return spawn(ELECTRON, ['--no-sandbox', '.'], { cwd: ROOT, env, stdio: 'ignore' })
}

async function waitBooted (timeoutMs = 90000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (running()) {
      try { const r = await fetch(`http://127.0.0.1:${PORT}/`, { signal: AbortSignal.timeout(2000) }); if (r.status < 500) { try { await r.body?.cancel() } catch {} return true } } catch {}
    }
    await sleep(1000)
  }
  return false
}

async function killChild (child) {
  if (!child || child.exitCode !== null) return
  child.kill('SIGTERM')
  for (let i = 0; i < 16 && child.exitCode === null; i++) await sleep(500)
  if (child.exitCode === null) { try { child.kill('SIGKILL') } catch {} await sleep(500) }
}

const setMarker = () => docker(['exec', NAME, 'sh', '-c', `mkdir -p .milpa && echo persisted > ${MARKER}`])
const getMarker = () => docker(['exec', NAME, 'sh', '-c', `cat ${MARKER} 2>/dev/null || echo ABSENT`]).trim()

async function measure (label, keep) {
  rmf()
  const env = keep ? { MILPA_KEEP_BACKEND: '1' } : {}
  const a = launch(env)
  const bootedA = await waitBooted()
  if (!bootedA) { await killChild(a); rmf(); return { label, keep, bootedA, result: 'house-did-not-boot' } }
  setMarker()
  const markerBefore = getMarker()
  await killChild(a)
  const containerAfterQuit = running()
  const b = launch(env)
  const bootedB = await waitBooted()
  const markerAfter = bootedB ? getMarker() : '(second boot failed)'
  await killChild(b)
  rmf()
  return { label, keep, bootedA, bootedB, markerBefore, containerAfterQuit, markerAfter, persisted: markerAfter === 'persisted' }
}

const out = {}
try {
  out.volumes = docker(['image', 'inspect', '--format', '{{json .Config.Volumes}}', IMAGE]).trim()
  out.normal = await measure('normal restart', false)
  out.keep = await measure('MILPA_KEEP_BACKEND=1', true)
} catch (e) {
  out.error = String(e && e.stack || e)
} finally {
  rmf()
  try { fs.rmSync(LABHOME, { recursive: true, force: true }) } catch {}
}
// The facts the migration story depends on: no volume; a normal restart gives a NEW house (state gone); only
// MILPA_KEEP_BACKEND=1 keeps it. A change here (e.g. someone adds a VOLUME) would change the advisory, so assert them.
const ok = !out.error &&
  out.volumes === 'null' &&
  out.normal && out.normal.bootedA && out.normal.bootedB && out.normal.persisted === false &&
  out.keep && out.keep.bootedA && out.keep.bootedB && out.keep.persisted === true
console.log('PERSIST ' + (ok ? 'PASS' : 'FAIL') + ' ' + JSON.stringify(out))
console.log(ok
  ? 'OK · a normal Desktop restart gives a NEW house (no volume, rm -f); only MILPA_KEEP_BACKEND=1 keeps it'
  : 'FAIL · persistence facts changed — re-check the migration section of decisions/0611')
process.exit(ok ? 0 : 1)
