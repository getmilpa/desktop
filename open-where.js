// Where the house's pages open: this window, or the person's browser (greenhouse decisions/0566) — out of main.js so
// it can be exercised without Electron.
//
// WHY THERE ARE TWO PLACES. Electron ships Chromium's WebAuthn without its dialogs — no PIN prompt — so a key that
// verifies its user by PIN, a YubiKey 5, could not answer a ceremony of the house in this window (evidence/1100). The
// Desktop now asks for that PIN itself where it can reach the key (decisions/0568: Linux); the browser stays the other
// door, and the first one where the Desktop cannot. What is remembered is where the panel was last opened: a launch
// opens it in the window by itself only for somebody whose key got them INTO the panel in this window before. Asking
// for the window is not that: a sign-in that never finished here must not become the next launch's dead end.
//
// (c) Rodrigo Vicente - TeamX Agency — Apache-2.0
const fs = require('node:fs')
const path = require('node:path')

const FILE = 'open-where.json'
const PLACES = ['browser', 'window']

// The link as a URL when it is of this house — same scheme, host and port — else null.
function linkOfThisHouse (url, origin) {
  let target = null
  try { target = new URL(String(url || '')) } catch { return null }
  return target.origin === origin ? target : null
}

// What the person chose last, or null. A file this did not write reads as nothing chosen.
function recall (dir) {
  try { const where = JSON.parse(fs.readFileSync(path.join(dir, FILE), 'utf8')).panel; return PLACES.includes(where) ? where : null } catch { return null }
}

// Remembering is a convenience: a directory that cannot be written costs the person one more click, never the launch.
function remember (dir, where) {
  if (!PLACES.includes(where)) return
  try { fs.writeFileSync(path.join(dir, FILE), JSON.stringify({ panel: where }) + '\n', { mode: 0o600 }) } catch {}
}

// Whether the window is on the house's panel — past the sign-in, which lives under another path.
function isThePanel (url, panelUrl) {
  try { const at = new URL(String(url || '')); const panel = new URL(panelUrl); return at.origin === panel.origin && (at.pathname === panel.pathname || at.pathname.startsWith(panel.pathname + '/')) } catch { return false }
}

function opensTheWindowAtLaunch (chosen, panelServed) { return panelServed === true && chosen === 'window' }

module.exports = { linkOfThisHouse, recall, remember, isThePanel, opensTheWindowAtLaunch, FILE }
