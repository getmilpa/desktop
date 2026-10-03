// Which image a launch runs — moved out of main.js verbatim so it can be exercised without Electron (greenhouse
// evidence/1095, G1). MILPA_IMAGE names one image and skips the choice; otherwise the FrankenPHP variant if it is here
// or can be pulled, else the plain one. A failed pull is not an error — it is the fallback.
//
// (c) Rodrigo Vicente - TeamX Agency — Apache-2.0
const { execFileSync } = require('node:child_process')

const IMAGE_PREFERRED = 'ghcr.io/getmilpa/framework:dev-frankenphp'
const IMAGE_FLOOR = 'ghcr.io/getmilpa/framework:dev'

const sh = (cmd, args, opts = {}) => execFileSync(cmd, args, { encoding: 'utf8', ...opts }).trim()

function chooseImage (env = process.env, docker = 'docker') {
  if (env.MILPA_IMAGE) return env.MILPA_IMAGE
  for (const img of [IMAGE_PREFERRED, IMAGE_FLOOR]) {
    try { sh(docker, ['image', 'inspect', img], { stdio: 'ignore' }); return img } catch {}
    try { sh(docker, ['pull', '--quiet', img], { stdio: 'ignore' }); return img } catch {}
  }
  return IMAGE_FLOOR
}

module.exports = { chooseImage, IMAGE_PREFERRED, IMAGE_FLOOR }
