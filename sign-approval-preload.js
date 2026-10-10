// The approval window's ONLY bridge (greenhouse decisions/0611, (b), point 2). It gives the page the authorization to
// render — including `canonical`, the exact bytes the host will sign — and two buttons' worth of answer back. The
// authorization and the one-time token arrive as process arguments (not over a channel the house could race), and the
// decision goes back tagged with that token; the main accepts it only from THIS window's webContents (host-approve.js).
const { contextBridge, ipcRenderer } = require('electron')

const arg = (p) => { const a = process.argv.find((x) => x.startsWith(p)); return a ? a.slice(p.length) : '' }
let authz = {}
try { authz = JSON.parse(decodeURIComponent(arg('--authz='))) } catch {}
const token = arg('--token=')

contextBridge.exposeInMainWorld('approval', {
  data: () => authz,
  approve: () => ipcRenderer.send('milpa:sign-approval', { token, ok: true }),
  deny: () => ipcRenderer.send('milpa:sign-approval', { token, ok: false }),
})
