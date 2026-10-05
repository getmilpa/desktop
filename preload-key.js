// The PIN window's bridge (greenhouse decisions/0568): it is shown what the ceremony is doing, and can say two things
// back — a PIN, or «close». Only the Desktop's own page gets it, and main takes an answer only from the window it
// opened for the ceremony in course.
const { contextBridge, ipcRenderer } = require('electron')

if (location.protocol === 'file:') {
  let seen = null; let show = null
  ipcRenderer.on('milpa:key:view', (_e, view) => { seen = view; if (show) show(view) })
  contextBridge.exposeInMainWorld('milpaKey', {
    onView: (f) => { show = f; if (seen) f(seen) },
    pin: (value) => ipcRenderer.send('milpa:key:answer', { pin: String(value) }),
    close: () => ipcRenderer.send('milpa:key:answer', { close: true }),
  })
}
