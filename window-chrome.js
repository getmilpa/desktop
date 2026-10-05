// The window's own keys and menu (greenhouse decisions/0563).
//
// The window shows the house's panel — a web page — and the Desktop took the native menu away because File/Edit/View
// mean nothing here. What a page still needs went with it: a way to RELOAD and a way BACK. Ctrl/Cmd+R survived as a
// key nobody could find (greenhouse evidence/1095 read the window as having no reload at all, and its script had
// Rod click «Agent» and pick the session again, three times a run). So the keys a browser answers to are here, and
// the right-click menu offers them by name.
//
// AND THE WAY TO THE BROWSER (greenhouse decisions/0566). A passkey ceremony of the house can be one this window is
// unable to finish — a key with a PIN where the Desktop cannot ask for it (evidence/1100; decisions/0568 covers
// Linux). The menu offers the page the window is on to the person's browser, where it can be.
//
// This is chrome of the WINDOW, in the main process. It hands the page nothing: the bridge stays where preload.js
// puts it — on the Desktop's own file: pages, never on an http page.
'use strict'

/** The words the menu shows, by key — English, the Desktop's default. */
const COPY = { 'window.back': 'Back', 'window.forward': 'Forward', 'window.reload': 'Reload', 'window.browser': 'Open in your browser' }

/**
 * What a key press asks of the window, or null when it is the page's own.
 * Reload: Ctrl/Cmd+R and F5; with Shift, past the cache. Back and forward: Alt+Left and Alt+Right. Devtools:
 * Ctrl/Cmd+Shift+I.
 */
function act (input) {
  if (!input || input.type !== 'keyDown') return null
  const key = String(input.key || '').toLowerCase()
  const mod = !!(input.control || input.meta)
  if (key === 'f5' && !input.alt) return mod || input.shift ? 'hard-reload' : 'reload'
  if (mod && !input.alt && key === 'r') return input.shift ? 'hard-reload' : 'reload'
  if (mod && input.shift && !input.alt && key === 'i') return 'devtools'
  if (input.alt && !mod && !input.shift && key === 'arrowleft') return 'back'
  if (input.alt && !mod && !input.shift && key === 'arrowright') return 'forward'
  return null
}

function history (w) { return w.webContents.navigationHistory }

/** Do it. Going back with nowhere to go back to does nothing. */
function run (w, what) {
  const c = w.webContents
  if (what === 'reload') c.reload()
  else if (what === 'hard-reload') c.reloadIgnoringCache()
  else if (what === 'devtools') c.toggleDevTools()
  else if (what === 'back' && history(w).canGoBack()) history(w).goBack()
  else if (what === 'forward' && history(w).canGoForward()) history(w).goForward()
}

/** The address the window is on when it is a web page — the house's — or null on the Desktop's own file: pages. */
function webPage (w) {
  try { const u = new URL(w.webContents.getURL()); return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : null } catch { return null }
}

/**
 * The right-click menu for where the pointer is: a field's cut/copy/paste first, then the way back and Reload — and,
 * on a web page, the way to the person's browser when the window was given one (`shell`).
 */
function menuTemplate (w, params, { shell } = {}) {
  const p = params || {}
  const page = shell ? webPage(w) : null
  const edit = p.isEditable
    ? [{ role: 'cut' }, { role: 'copy' }, { role: 'paste' }, { type: 'separator' }]
    : (p.selectionText ? [{ role: 'copy' }, { type: 'separator' }] : [])
  return [
    ...edit,
    { label: COPY['window.back'], enabled: history(w).canGoBack(), click: () => run(w, 'back') },
    { label: COPY['window.forward'], enabled: history(w).canGoForward(), click: () => run(w, 'forward') },
    { label: COPY['window.reload'], accelerator: 'CmdOrCtrl+R', click: () => run(w, 'reload') },
    ...(page ? [{ label: COPY['window.browser'], click: () => { shell.openExternal(page) } }] : []),
  ]
}

/** Give a window its keys and its menu — and every window it opens on this house, the same. */
function attach (w, { Menu, shell }) {
  w.webContents.on('before-input-event', (e, input) => {
    const what = act(input)
    if (what === null) return
    e.preventDefault()
    run(w, what)
  })
  w.webContents.on('context-menu', (_e, params) => { Menu.buildFromTemplate(menuTemplate(w, params, { shell })).popup({ window: w }) })
  w.webContents.on('did-create-window', (child) => attach(child, { Menu, shell }))
}

module.exports = { act, run, menuTemplate, attach, COPY }
