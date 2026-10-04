// Where the house's pages open — this window or the person's browser (greenhouse decisions/0566). Plain node, no
// Electron: the real module, a temp directory for what it remembers. Exits non-zero on a failure.
//
// (c) Rodrigo Vicente - TeamX Agency — Apache-2.0
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')

const checks = []
function record (name, ok, detail) { checks.push({ name, ok: !!ok }); console.log((ok ? 'PASS' : 'FAIL') + ' · ' + name + (ok || !detail ? '' : ' — ' + detail)) }

let where = null
try { where = require('../open-where.js') } catch (e) { record('open-where.js is a module main.js and this test share', false, String(e.message).split('\n')[0]) }

if (where) {
  const ORIGIN = 'http://localhost:8899'
  const of = (u) => { const t = where.linkOfThisHouse(u, ORIGIN); return t ? t.href : null }
  record('a link of this house is one', of('http://localhost:8899/webauthn/enroll?invite=abc') === 'http://localhost:8899/webauthn/enroll?invite=abc')
  const foreign = ['https://evil.example/webauthn/enroll', 'http://localhost:8898/', 'http://127.0.0.1:8899/', 'https://localhost:8899/', 'file:///etc/passwd', 'javascript:alert(1)', 'http://localhost:8899@evil.example/', '', null, undefined, 42]
  const admitted = foreign.filter(u => of(u) !== null)
  record('another origin, another port, an IP, a file, a script, a userinfo trick and nothing at all are not [negative control]', admitted.length === 0, JSON.stringify(admitted))

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'milpa-open-where-'))
  record('nothing chosen yet: nothing is remembered', where.recall(dir) === null)
  record('…so a launch on a house with its panel stays on the boot screen, which offers both', where.opensTheWindowAtLaunch(where.recall(dir), true) === false)
  where.remember(dir, 'browser')
  record('the browser was chosen: it is remembered', where.recall(dir) === 'browser')
  record('…and the next launch does not put a sign-in in the window', where.opensTheWindowAtLaunch(where.recall(dir), true) === false)
  where.remember(dir, 'window')
  record('the window was chosen: the next launch opens the panel in it', where.recall(dir) === 'window' && where.opensTheWindowAtLaunch(where.recall(dir), true) === true)
  record('…but only on a house that serves its panel', where.opensTheWindowAtLaunch('window', false) === false)
  where.remember(dir, 'somewhere else')
  record('a choice that is neither is not written over the last one [negative control]', where.recall(dir) === 'window')
  fs.writeFileSync(path.join(dir, where.FILE), '{not json')
  record('a file that is not what this wrote reads as nothing chosen', where.recall(dir) === null)
  record('a directory that cannot be written does not throw', (() => { try { where.remember(path.join(dir, 'missing', 'deeper'), 'browser'); return where.recall(path.join(dir, 'missing', 'deeper')) === null } catch { return false } })())
  fs.rmSync(dir, { recursive: true, force: true })
}

// A module main.js loads and the build does not pack is a Desktop that starts from source and dies as an AppImage.
const packed = require('../package.json').build.files
const loaded = [...fs.readFileSync(path.join(__dirname, '..', 'main.js'), 'utf8').matchAll(/require\('\.\/([\w-]+\.js)'\)/g)].map(m => m[1])
const unpacked = loaded.filter(f => !packed.includes(f))
record('every module main.js loads is in the build\'s files — ' + loaded.join(', '), loaded.includes('open-where.js') && unpacked.length === 0, 'not packed: ' + unpacked.join(', '))

const failed = checks.filter(c => !c.ok)
console.log('\n' + (checks.length - failed.length) + '/' + checks.length + ' open-where checks passed')
process.exit(failed.length ? 1 : 0)
