// Which image the Desktop runs when nobody names one (greenhouse evidence/1095, G1). Plain node, no Electron: the real
// chooseImage() asks a FAKE `docker` — a script that answers `image inspect` and `pull` from a state file and logs every
// call — so the test exercises the exact calls main makes, including how their answer is read. Exits non-zero on a failure.
//
// (c) Rodrigo Vicente - TeamX Agency — Apache-2.0
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { chooseImage, IMAGE_PREFERRED, IMAGE_FLOOR } = require('../choose-image.js')

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'milpa-choose-image-'))
const docker = path.join(dir, 'docker')
const state = path.join(dir, 'state')
const calls = path.join(dir, 'calls')
// The fake: `image inspect <img>` succeeds when the state lists `here <img>`; `pull --quiet <img>` succeeds when it
// lists `pullable <img>`. Like the real one, it prints on success — the caller must not depend on reading that.
fs.writeFileSync(docker, `#!/bin/sh
echo "$*" >> "${calls}"
case "$1" in
  image) grep -qx "here $3" "${state}" && { echo '[{"Id":"sha256:fake"}]'; exit 0; }; echo "Error: No such image: $3" >&2; exit 1 ;;
  pull)  grep -qx "pullable $3" "${state}" && { echo "$3"; exit 0; }; echo "Error: manifest unknown" >&2; exit 1 ;;
esac
exit 2
`, { mode: 0o755 })

const checks = []
function record (name, ok, detail) { checks.push({ name, ok: !!ok }); console.log((ok ? 'PASS' : 'FAIL') + ' · ' + name + (ok || !detail ? '' : ' — ' + detail)) }
function arm (lines, env = {}) {
  fs.writeFileSync(state, lines.join('\n') + '\n'); fs.writeFileSync(calls, '')
  const chosen = chooseImage(env, docker)
  return { chosen, calls: fs.readFileSync(calls, 'utf8').trim().split('\n').filter(Boolean) }
}

let r = arm([`here ${IMAGE_PREFERRED}`, `here ${IMAGE_FLOOR}`])
record('the FrankenPHP variant is here: it is the one that runs', r.chosen === IMAGE_PREFERRED, r.chosen)
record('…and nothing is pulled for an image that is already here', !r.calls.some(c => c.startsWith('pull')), r.calls.join(' | '))

r = arm([`pullable ${IMAGE_PREFERRED}`, `here ${IMAGE_FLOOR}`])
record('the variant is not here but can be pulled: it is pulled and runs', r.chosen === IMAGE_PREFERRED && r.calls.includes(`pull --quiet ${IMAGE_PREFERRED}`), r.chosen + ' · ' + r.calls.join(' | '))

r = arm([`here ${IMAGE_FLOOR}`])
record('the variant cannot be had: the plain image is the floor', r.chosen === IMAGE_FLOOR, r.chosen)
record('…and the variant was asked for FIRST', r.calls[0] === `image inspect ${IMAGE_PREFERRED}`, r.calls.join(' | '))

r = arm([`pullable ${IMAGE_FLOOR}`])
record('neither is here, only the plain one can be pulled: it is pulled', r.chosen === IMAGE_FLOOR && r.calls.includes(`pull --quiet ${IMAGE_FLOOR}`), r.chosen + ' · ' + r.calls.join(' | '))

r = arm([])
record('nothing can be had: the floor is named, so the launch fails on the image and says which', r.chosen === IMAGE_FLOOR, r.chosen)

r = arm([`here ${IMAGE_PREFERRED}`], { MILPA_IMAGE: 'local/house:lab' })
record('MILPA_IMAGE names one image and skips the choice — docker is not asked', r.chosen === 'local/house:lab' && r.calls.length === 0, r.chosen + ' · ' + r.calls.join(' | '))

fs.rmSync(dir, { recursive: true, force: true })
const failed = checks.filter(c => !c.ok)
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`)
process.exit(failed.length ? 1 : 0)
