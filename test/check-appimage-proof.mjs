// Apache-2.0 · (c) Rodrigo Vicente - TeamX Agency
// Bind release upload to the very bytes that passed the packaged-app gate.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { pathToFileURL } from 'node:url'

export function checkProof (image, proof) {
  const report = JSON.parse(fs.readFileSync(proof, 'utf8'))
  const digest = crypto.createHash('sha256').update(fs.readFileSync(image)).digest('hex')
  const expected = [['direct', true], ['desktop', true], ['disabled-control', false]]
  if (report.schema !== 1 || report.passed !== true || report.mode !== 'mounted-appimage' || report.scope !== 'boot-window renderer' ||
      report.artifact !== path.basename(image) || report.sha256 !== digest || report.cases?.length !== expected.length ||
      !expected.every(([route, active], index) => report.cases[index].route === route && report.cases[index].active === active)) {
    throw new Error('Release artifact does not match a successful AppImage sandbox proof')
  }
  return digest
}
if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  if (process.argv.length !== 4) throw new Error('Usage: node test/check-appimage-proof.mjs APPIMAGE REPORT.json')
  console.log('AppImage sandbox proof matches ' + checkProof(...process.argv.slice(2)))
}
