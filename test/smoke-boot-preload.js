// Fixture window.milpa for the boot-screen smoke — canned boot states, no container. The test moves the phase with
// `bootSet` and reads what the page asked main to open with `bootOpened` (this window) and `bootBrowsed` (the browser).
const { contextBridge } = require('electron')
const ORIGIN = 'http://localhost:8899'
const run = 'docker exec -it milpa-desktop-backend php bin/coa'
let state = { phase: 'starting', error: null, panel: false }
const opened = []
const browsed = []
contextBridge.exposeInMainWorld('milpa', {
  boot: async () => ({
    ...state, origin: ORIGIN, panelUrl: `${ORIGIN}/webauthn/signin?next=%2Fmilpa%2Fadmin`,
    container: state.phase === 'starting' ? null : 'milpa-desktop-backend', image: 'ghcr.io/getmilpa/framework:dev-frankenphp', server: 'frankenphp',
    commands: { run, panel: `${run} capabilities:enable milpa/admin --sign` },
  }),
  openInWindow: async (url) => { opened.push(url); return { ok: true } },
  openInBrowser: async (url) => { browsed.push(url); return { ok: true } },
  bootSet: (next) => { state = { ...state, ...next } },
  bootOpened: () => opened.slice(),
  bootBrowsed: () => browsed.slice(),
})
