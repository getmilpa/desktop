// Which image a launch runs — out of main.js so it can be exercised without Electron (greenhouse evidence/1095, G1). MILPA_IMAGE names one image and skips the choice; otherwise the FrankenPHP variant if it is here
// or can be pulled, else the plain one. A failed pull is not an error — it is the fallback.
//
// (c) Rodrigo Vicente - TeamX Agency — Apache-2.0
const { execFileSync } = require('node:child_process')

const IMAGE_PREFERRED = 'ghcr.io/getmilpa/framework:dev-frankenphp'
const IMAGE_FLOOR = 'ghcr.io/getmilpa/framework:dev'

// A yes/no question to docker: the exit status IS the answer, and the output is discarded. It must not be read:
// with `stdio: 'ignore'` execFileSync returns null, and the old `sh(...).trim()` threw on every call — an image that
// was here, or pulled fine, read as "cannot be had", so the choice always fell to the floor (evidence/1095, G1).
function answers (docker, args) {
  try { execFileSync(docker, args, { stdio: 'ignore' }); return true } catch { return false }
}

function chooseImage (env = process.env, docker = 'docker') {
  if (env.MILPA_IMAGE) return env.MILPA_IMAGE
  for (const img of [IMAGE_PREFERRED, IMAGE_FLOOR]) {
    if (answers(docker, ['image', 'inspect', img])) return img
    if (answers(docker, ['pull', '--quiet', img])) return img
  }
  return IMAGE_FLOOR
}

module.exports = { chooseImage, IMAGE_PREFERRED, IMAGE_FLOOR }
