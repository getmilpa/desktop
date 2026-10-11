// THE APPROVAL (greenhouse decisions/0611, (b), point 2). Before the host signs, a PERSON must see the operation and
// approve it — and that approval must live where the house cannot reach it. This builds the `approve(authorization)`
// the host signer (host-signer.js) calls: it opens a window the Electron MAIN owns, loaded from a file:// page of this
// app with its own narrow preload, modal to the main window, un-navigable. Nothing the house serves (an http page in
// the main window) can draw over it, enumerate it, or answer for it: the decision comes back only from THAT window's
// own button, over a channel gated to THAT window's webContents and this request's one-time token.
//
// This module reads NO environment variable: a security patch must not carry a switch that weakens approval. Behaviour
// is set only through makeApprover's options, and the Desktop's main passes none of the test-only ones (host-signer.log
// is the only thing it configures). A measurement passes its own options and drives the window itself.

'use strict'

const path = require('node:path')
const fs = require('node:fs')
const crypto = require('node:crypto')

// The approval window's deadline. SHORTER than the house's freshness window (OperationAuthorizer = 120s), with margin,
// so a slow approval refuses cleanly instead of being signed into a 120–180s dead zone the house then rejects as
// expired AFTER the person said yes (0611 review). The window also counts this down so the person sees the time left.
const APPROVAL_WINDOW_MS = 90000

// Build the approver. `BrowserWindow`, `ipcMain`, `app` from electron; `root` is the app dir (__dirname of main);
// `parent` is the main window (the approval is modal to it); `timeoutMs` turns a person who never answers into a
// refusal (point 4); `logFile` persists each decision; `onShown(authorization, token)` is called in the MAIN when a
// window opens (audit of what was asked, and a test's correlation of the one-time token the main generated).
//
// `allowAnySender` is TEST-ONLY and MUST stay false in production (the Desktop's main never passes it): a measurement
// sets it to prove, by mutation, that the sender gate — not the token — is what refuses a forged decision. Returns
// `approve(authorization) => Promise<boolean>`.
function makeApprover ({ app, BrowserWindow, ipcMain, root, parent = null, timeoutMs = APPROVAL_WINDOW_MS, logFile = null, onShown = null, allowAnySender = false }) {
  // One at a time: the host signer serializes a connection's request, but two contained houses could ask at once; a
  // chain keeps each person-facing window about one operation, never a stack the person rushes through.
  let chain = Promise.resolve()
  return (authorization) => {
    const run = () => showOne({ BrowserWindow, ipcMain, root, parent, timeoutMs, logFile, onShown, allowAnySender, authorization })
    chain = chain.then(run, run)
    return chain
  }
}

function showOne ({ BrowserWindow, ipcMain, root, parent, timeoutMs, logFile, onShown, allowAnySender, authorization }) {
  return new Promise((resolve) => {
    const token = crypto.randomBytes(16).toString('hex')
    const deadline = Date.now() + timeoutMs
    let win = null
    let settled = false
    const onDecision = (e, msg) => {
      // Only THIS window may answer — not the house page, not any other renderer. The sender gate is first and
      // non-negotiable; the token (one-time, carried in this window's argv) is the second lock, not the only one.
      if (!win || (e.sender !== win.webContents && !allowAnySender)) return
      if (!msg || msg.token !== token) return
      finish(msg.ok === true)
    }
    const finish = (ok) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { ipcMain.removeListener('milpa:sign-approval', onDecision) } catch {}
      try { if (win && !win.isDestroyed()) { win.removeAllListeners('closed'); win.close() } } catch {}
      // Who asked, what, and how it ended — the record point 4 requires (the payload itself is not logged). Persisted
      // to a file, because console.log is unread in a packaged app; also echoed to the console in dev.
      const line = `${new Date().toISOString()} approval ${ok ? 'granted' : 'refused'}: ${authorization.operation} host=${authorization.host} issuedAt=${authorization.issuedAt}`
      try { console.log('[host-signer] ' + line) } catch {}
      if (logFile) { try { fs.appendFileSync(logFile, line + '\n') } catch {} }
      resolve(ok === true)
    }
    ipcMain.on('milpa:sign-approval', onDecision)
    const timer = setTimeout(() => finish(false), timeoutMs)

    const payload = encodeURIComponent(JSON.stringify(authorization))
    win = new BrowserWindow({
      width: 540, height: 620, title: 'Approve a signature', backgroundColor: '#17120D', autoHideMenuBar: true,
      parent: parent || undefined, modal: !!parent, show: true, resizable: false, minimizable: false, maximizable: false,
      webPreferences: {
        preload: path.join(root, 'sign-approval-preload.js'),
        additionalArguments: [`--authz=${payload}`, `--token=${token}`, `--deadline=${deadline}`],
        contextIsolation: true, nodeIntegration: false, sandbox: true,
      },
    })
    // Never leaves the approval page: a page of the house must not become this window, and a popup is denied.
    win.webContents.on('will-navigate', (e) => e.preventDefault())
    win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
    win.on('closed', () => finish(false)) // closing the window IS a refusal (point 4)
    win.loadFile(path.join(root, 'renderer', 'sign-approval.html'))
    if (onShown) { try { onShown(authorization, token) } catch {} }
  })
}

module.exports = { makeApprover, APPROVAL_WINDOW_MS }
