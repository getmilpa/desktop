// Apache-2.0 · (c) Rodrigo Vicente - TeamX Agency
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import crypto from 'node:crypto'
import { desktopArguments, sandboxActive } from './appimage-sandbox.mjs'
import { checkProof } from './check-appimage-proof.mjs'

test('the launcher parser preserves a disabling argument and refuses ambiguous execution', () => {
  assert.deepEqual(desktopArguments('[Desktop Entry]\nExec=AppRun --no-sandbox %U\n'), ['--no-sandbox'])
  assert.deepEqual(desktopArguments('Exec=AppRun --enable-sandbox %U'), ['--enable-sandbox'])
  for (const text of ['Exec=AppRun --enable-sandbox %U\nExec=AppRun --no-sandbox %U', 'Exec=sh -c AppRun', 'Exec=AppRun --unknown=value %U']) assert.throws(() => desktopArguments(text))
})
test('inherited seccomp and no-new-privileges cannot certify the renderer', () => {
  const base = { uid: 1000, noNewPrivs: 1, seccomp: 2, filters: 1, capEff: '0000000000000000', nsPids: [20] }
  assert.equal(sandboxActive(base, { ...base, nsPids: [30] }), false)
  assert.equal(sandboxActive(base, { ...base, nsPids: [30, 1] }), false)
  assert.equal(sandboxActive(base, { ...base, filters: 2 }), false)
  assert.equal(sandboxActive(base, { ...base, filters: 2, nsPids: [30, 1] }), true)
})
test('release rejects replaced bytes, failed proofs and missing negative control', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'appimage-proof-'))
  try {
    const image = path.join(dir, 'app.AppImage'), proof = path.join(dir, 'proof.json')
    fs.writeFileSync(image, 'candidate bytes')
    const report = { schema: 1, passed: true, mode: 'mounted-appimage', scope: 'boot-window renderer', artifact: 'app.AppImage', sha256: crypto.createHash('sha256').update(fs.readFileSync(image)).digest('hex'), cases: [{ route: 'direct', active: true }, { route: 'desktop', active: true }, { route: 'disabled-control', active: false }] }
    const write = value => fs.writeFileSync(proof, JSON.stringify(value))
    write(report); assert.equal(checkProof(image, proof), report.sha256)
    write({ ...report, passed: false }); assert.throws(() => checkProof(image, proof))
    write({ ...report, cases: report.cases.slice(0, 2) }); assert.throws(() => checkProof(image, proof))
    write(report); fs.appendFileSync(image, 'replaced'); assert.throws(() => checkProof(image, proof))
  } finally { fs.rmSync(dir, { recursive: true, force: true }) }
})

test('termination cleans its detached group and refuses new work during cleanup', async () => {
  const { spawn } = await import('node:child_process')
  const { liveGroup } = await import('./owned-processes.mjs')
  const moduleUrl = new URL('./owned-processes.mjs', import.meta.url).href
  const code = `import {spawnOwned,installSignalCleanup} from ${JSON.stringify(moduleUrl)}; installSignalCleanup(); const child=spawnOwned(process.execPath,['-e','process.on("SIGTERM",()=>{});setInterval(()=>{},1000)'],{stdio:'ignore'}); console.log(child.pid); process.on('SIGTERM',()=>setTimeout(()=>{try {spawnOwned(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});console.error('late launch escaped')} catch {console.error('late launch refused')}},25)); setInterval(()=>{},1000)`
  const wrapper = spawn(process.execPath, ['--input-type=module', '-e', code], { stdio: ['ignore', 'pipe', 'pipe'] })
  let pid, stderr = ''
  wrapper.stderr.on('data', chunk => { stderr += chunk })
  try {
    pid = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Fixture did not start')), 3000)
      wrapper.stdout.once('data', chunk => { clearTimeout(timer); resolve(Number(String(chunk).trim())) })
      wrapper.once('error', reject)
    })
    assert.equal(Number.isInteger(pid) && pid > 0, true)
    await new Promise(resolve => setTimeout(resolve, 100))
    const ended = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Signal cleanup did not finish')), 3000)
      wrapper.once('exit', (code, signal) => { clearTimeout(timer); resolve({ code, signal }) })
    })
    wrapper.kill('SIGTERM')
    assert.deepEqual(await ended, { code: 143, signal: null })
    assert.deepEqual(liveGroup(pid), [])
    assert.match(stderr, /late launch refused/)
    assert.doesNotMatch(stderr, /late launch escaped/)
  } finally {
    wrapper.kill('SIGKILL')
    if (pid) { try { process.kill(-pid, 'SIGKILL') } catch {} }
  }
})
