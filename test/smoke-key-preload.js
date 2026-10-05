// Fixture for smoke-key.js: a page handed the Desktop's two security-key channels RAW — what a page would have if the
// real preload's own check (the house's origin, the top frame) were gone. It is how the test measures main's lock by
// itself: with this in every frame, main must still refuse everybody but the top frame of a page of the house.
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('raw', {
  webauthn: (req) => ipcRenderer.invoke('milpa:webauthn', req),
  keyAnswer: (a) => ipcRenderer.send('milpa:key:answer', a),
})
