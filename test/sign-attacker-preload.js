// A HOSTILE stand-in for the house (greenhouse decisions/0611 measure, point 2). It exposes the raw approval channel
// so the smoke can prove a renderer that is NOT the approval window — exactly what a page the house serves would be —
// cannot answer an approval, even with a leaked token. In the real Desktop no page is given this; the house page's
// preload (preload.js) exposes nothing of the kind. This file is test-only.
const { contextBridge, ipcRenderer } = require('electron')
contextBridge.exposeInMainWorld('attack', {
  decide: (token, ok) => ipcRenderer.send('milpa:sign-approval', { token, ok }),
})
