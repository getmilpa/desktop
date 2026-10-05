// The Desktop's side of a ceremony with a security key: who may ask for one, and the window that asks for the PIN
// (greenhouse decisions/0568). This is the only file of security-key/ that knows Electron.
//
// WHO MAY ASK. One channel, `milpa:webauthn`, and one kind of caller: the top frame of a page of THIS house — the
// origin the Desktop declared to it. Not a frame inside a page, not another origin, not a second request while one
// is open. What a caller gets is what `navigator.credentials` gives any page in any browser, and nothing else: this
// is not the bridge that runs docker and gpg (preload.js keeps that on the Desktop's own file: pages, decisions/0563).
//
// WHO SEES THE PIN. The window below — a page of this app, loaded from disk — and this process, for as long as it
// takes to prove it to the key. Not the house's page, which is in another window and is handed only the key's answer.
// It is not written anywhere and not logged.
//
// (c) Rodrigo Vicente - TeamX Agency — Apache-2.0
'use strict'
const path = require('node:path')
const { ceremony, WORDS } = require('./ceremony.js')

function attach ({ ipcMain, BrowserWindow, house, root, discover }) {
  let open = null   // the one ceremony's window, while there is one

  // The PIN window, made when the ceremony first has something to show — a ceremony that is Chromium's never opens it.
  function windowFor (parent) {
    const stop = new AbortController()
    const ui = { signal: stop.signal, win: null }
    let loaded = null; let waiting = null; let over = false
    const settle = (value) => { if (waiting) { const w = waiting; waiting = null; w(value) } }
    const show = async (view) => {
      if (over) return
      if (!ui.win) {
        ui.win = new BrowserWindow({
          parent: parent || undefined, modal: !!parent, show: false, useContentSize: true, width: 500, height: 540, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
          title: 'Milpa Desktop', backgroundColor: '#17120D', autoHideMenuBar: true,
          webPreferences: { preload: path.join(root, 'preload-key.js'), contextIsolation: true, nodeIntegration: false },
        })
        // The window is this ceremony's and nothing else: it goes nowhere and opens nothing.
        ui.win.webContents.on('will-navigate', (e) => e.preventDefault())
        ui.win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
        // Closing it is the person saying no — whatever it was showing.
        ui.win.on('closed', () => { ui.win = null; if (!over) { settle(null); stop.abort() } })
        const w = ui.win
        loaded = w.loadFile(path.join(root, 'renderer', 'key.html')).then(() => { if (!w.isDestroyed()) w.show() })
      }
      await loaded
      if (ui.win && !over) ui.win.webContents.send('milpa:key:view', view)
    }
    ui.tell = (view) => { show(view).catch(() => {}) }
    ui.askPin = async (view) => { await show(view); if (!ui.win) return null; return new Promise((resolve) => { waiting = resolve }) }
    ui.acknowledge = async (view) => { await show(view); if (!ui.win) return; return new Promise((resolve) => { waiting = resolve }) }
    // What the window said back: a PIN, or that it is done with what it shows.
    ui.answer = (a) => {
      if (a && typeof a.pin === 'string') return settle(a.pin)
      if (waiting) return settle(null)
      stop.abort()
    }
    ui.cancel = () => { settle(null); stop.abort() }
    ui.end = () => { over = true; settle(null); if (ui.win && !ui.win.isDestroyed()) ui.win.destroy(); ui.win = null }
    return ui
  }

  ipcMain.on('milpa:key:answer', (e, a) => {
    let own = false
    try { own = !!open && !!open.win && e.sender === open.win.webContents && new URL(e.senderFrame.url).protocol === 'file:' } catch {}
    if (own) open.answer(a)
  })

  ipcMain.handle('milpa:webauthn', async (e, req) => {
    const refuse = (name) => ({ error: { name, message: WORDS[name] || WORDS.NotAllowedError } })
    let frame = null
    try { frame = e.senderFrame } catch {}
    if (!frame || frame.parent !== null || frame.origin !== house) return refuse('NotAllowedError')
    if (open) return refuse('NotAllowedError')
    const ui = open = windowFor(BrowserWindow.fromWebContents(e.sender))
    // The page that asked going away — a reload, a navigation, its window closed — ends the ceremony with it.
    const leave = (d) => { if (d && (d.isMainFrame === false || d.isSameDocument === true)) return; ui.cancel() }
    e.sender.on('did-start-navigation', leave); e.sender.on('destroyed', leave)
    try {
      return await ceremony({ kind: req && req.kind, origin: frame.origin, publicKey: req && req.publicKey, ui, discover })
    } catch (err) {
      return refuse(WORDS[err && err.name] ? err.name : 'NotAllowedError')
    } finally {
      try { e.sender.removeListener('did-start-navigation', leave); e.sender.removeListener('destroyed', leave) } catch {}
      ui.end()
      open = null
    }
  })
}

module.exports = { attach }
