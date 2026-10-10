// THE APPROVAL (greenhouse decisions/0611, (b), point 2). Before the host signs, a PERSON must see the operation and
// approve it — and that approval must live where the house cannot reach it. This builds the `approve(authorization)`
// the host signer (host-signer.js) calls: it opens a window the Electron MAIN owns, loaded from a file:// page of this
// app with its own narrow preload, modal to the main window, un-navigable. Nothing the house serves (an http page in
// the main window) can draw over it, enumerate it, or answer for it: the decision comes back only from THAT window's
// own button, over a channel gated to THAT window's webContents and this request's one-time token.
//
// `approve` is what the signer injects; a measurement injects its own (the host signer stays testable without a UI).

'use strict'

const path = require('node:path')
const crypto = require('node:crypto')

// Build the approver. `BrowserWindow`, `ipcMain`, `app` from electron; `root` is the app dir (__dirname of main);
// `parent` is the main window (the approval is modal to it); `timeoutMs` turns a person who never answers into a
// refusal (point 4). Returns `approve(authorization) => Promise<boolean>`.
function makeApprover ({ app, BrowserWindow, ipcMain, root, parent = null, timeoutMs = 180000 }) {
  // One at a time: the host signer serializes a connection's request, but two contained houses could ask at once; a
  // chain keeps each person-facing window about one operation, never a stack the person rushes through.
  let chain = Promise.resolve()
  return (authorization) => {
    const run = () => showOne({ BrowserWindow, ipcMain, root, parent, timeoutMs, authorization })
    chain = chain.then(run, run)
    return chain
  }
}

function showOne ({ BrowserWindow, ipcMain, root, parent, timeoutMs, authorization }) {
  return new Promise((resolve) => {
    const token = crypto.randomBytes(16).toString('hex')
    let win = null
    let settled = false
    const onDecision = (e, msg) => {
      // Only THIS window may answer (not the house page, not any other renderer), and only with THIS request's token.
      if (!win || e.sender !== win.webContents) return
      if (!msg || msg.token !== token) return
      finish(msg.ok === true)
    }
    const finish = (ok) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { ipcMain.removeListener('milpa:sign-approval', onDecision) } catch {}
      try { if (win && !win.isDestroyed()) { win.removeAllListeners('closed'); win.close() } } catch {}
      // who asked, what, and how it ended — the record point 4 requires (the payload itself is not logged).
      try { console.log(`[host-signer] approval ${ok ? 'granted' : 'refused'}: ${authorization.operation} host=${authorization.host} issuedAt=${authorization.issuedAt}`) } catch {}
      resolve(ok === true)
    }
    ipcMain.on('milpa:sign-approval', onDecision)
    const timer = setTimeout(() => finish(false), timeoutMs)

    const payload = encodeURIComponent(JSON.stringify(authorization))
    win = new BrowserWindow({
      width: 540, height: 600, title: 'Approve a signature', backgroundColor: '#17120D', autoHideMenuBar: true,
      parent: parent || undefined, modal: !!parent, show: true, resizable: false, minimizable: false, maximizable: false,
      webPreferences: {
        preload: path.join(root, 'sign-approval-preload.js'),
        additionalArguments: [`--authz=${payload}`, `--token=${token}`],
        contextIsolation: true, nodeIntegration: false, sandbox: true,
      },
    })
    // Never leaves the approval page: a page of the house must not become this window, and a popup is denied.
    win.webContents.on('will-navigate', (e) => e.preventDefault())
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.on('closed', () => finish(false)) // closing the window IS a refusal (point 4)
    win.loadFile(path.join(root, 'renderer', 'sign-approval.html'))

    // TEST SEAM — measurement only, never set in production. It drives the REAL window's own button (so the ceremony
    // is exercised end to end under xvfb without a human finger) and can save a screenshot of what was shown.
    const auto = process.env.MILPA_SIGN_AUTODECIDE // 'approve' | 'deny'
    if (auto === 'approve' || auto === 'deny') {
      win.webContents.once('did-finish-load', async () => {
        try {
          if (process.env.MILPA_SIGN_SHOT) { try { require('node:fs').writeFileSync(process.env.MILPA_SIGN_SHOT, (await win.webContents.capturePage()).toPNG()) } catch {} }
          await win.webContents.executeJavaScript(`document.querySelector('#${auto}').click()`)
        } catch { finish(false) }
      })
    }
  })
}

module.exports = { makeApprover }
