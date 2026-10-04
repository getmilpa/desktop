// Headless smoke test for the window's own keys and menu (greenhouse decisions/0563): the window shows the house's
// panel — a web page — and a person must be able to reload it and go back. A local page stands in for the panel;
// the keys are sent as input events, the way a keyboard sends them. Exits non-zero if any check fails.
const { app, BrowserWindow, Menu } = require('electron')
const http = require('http')
const path = require('path')
const ROOT = path.join(__dirname, '..')
const sleep = ms => new Promise(r => setTimeout(r, ms))
app.commandLine.appendSwitch('no-sandbox'); app.commandLine.appendSwitch('disable-gpu'); app.disableHardwareAcceleration()

const checks = []
function record (name, ok, detail) { checks.push({ name, ok: !!ok, detail }); console.log((ok ? 'PASS' : 'FAIL') + ' · ' + name + (ok || !detail ? '' : ' — ' + detail)) }

// A harness that hangs proves nothing: past a minute it says so and fails.
setTimeout(() => { console.log('FAIL · the harness finished within a minute'); app.exit(1) }, 60000)

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null)
  // The stand-in panel: every GET is counted, so a reload is something the SERVER saw, not something inferred.
  const served = { '/': 0, '/second': 0 }
  const server = http.createServer((req, res) => {
    const at = req.url.split('?')[0]
    if (at in served) served[at] += 1
    res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' })
    res.end(`<!doctype html><title>panel</title><input id="field"><p id="at">${at}</p><a id="next" href="/second">second</a>`)
  })
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve))
  const origin = 'http://127.0.0.1:' + server.address().port

  // The REAL preload, so «the bridge is not exposed to the panel» is measured on the file the Desktop ships.
  const win = new BrowserWindow({ width: 900, height: 700, show: true, webPreferences: { preload: path.join(ROOT, 'preload.js'), contextIsolation: true, nodeIntegration: false } })
  const js = c => win.webContents.executeJavaScript(c)
  const key = async (keyCode, modifiers = []) => {
    win.webContents.sendInputEvent({ type: 'keyDown', keyCode, modifiers })
    win.webContents.sendInputEvent({ type: 'keyUp', keyCode, modifiers })
    await sleep(500)
  }
  try {
    let chrome = null
    try { chrome = require(path.join(ROOT, 'window-chrome.js')) } catch (e) { record('the window\'s keys are a module main.js and this test share', false, String(e.message).split('\n')[0]) }
    // The system's browser, stood in for: what the menu hands it is recorded, and nothing is opened on this machine.
    const browsed = []
    const shell = { openExternal: async (u) => { browsed.push(u) } }
    if (chrome) chrome.attach(win, { Menu, shell })

    // What a key asks for, read off the module itself: a key going UP asks for nothing, or every reload would be two.
    const asks = (input) => chrome ? chrome.act(input) : undefined
    const table = [
      [{ type: 'keyDown', key: 'r', control: true }, 'reload'], [{ type: 'keyUp', key: 'r', control: true }, null],
      [{ type: 'keyDown', key: 'R', meta: true, shift: true }, 'hard-reload'], [{ type: 'keyDown', key: 'F5' }, 'reload'],
      [{ type: 'keyDown', key: 'r', control: true, alt: true }, null], [{ type: 'keyDown', key: 'r' }, null],
      [{ type: 'keyDown', key: 'ArrowLeft', alt: true }, 'back'], [{ type: 'keyDown', key: 'ArrowLeft' }, null],
      [{ type: 'keyDown', key: 'I', control: true, shift: true }, 'devtools'], [{ type: 'keyDown', key: 'i', control: true }, null],
    ]
    const wrong = table.filter(([input, want]) => asks(input) !== want).map(([input]) => JSON.stringify(input))
    record('each key asks for one thing, and a key going up asks for nothing', wrong.length === 0, wrong.join(' '))

    await win.loadURL(origin + '/'); await sleep(300)
    record('the stand-in panel loaded once', served['/'] === 1, JSON.stringify(served))

    await key('R', ['control'])
    record('Ctrl+R reloads the page', served['/'] === 2, JSON.stringify(served))
    await key('R', ['meta'])
    record('Cmd+R reloads the page', served['/'] === 3, JSON.stringify(served))
    await key('F5')
    record('F5 reloads the page', served['/'] === 4, JSON.stringify(served))
    await key('R', ['control', 'shift'])
    record('Ctrl+Shift+R reloads it too', served['/'] === 5, JSON.stringify(served))

    await key('R')
    await key('T', ['control'])
    await key('F6')
    record('a plain «r», Ctrl+T and F6 reload nothing [negative control]', served['/'] === 5, JSON.stringify(served))

    await js("document.querySelector('#field').focus()")
    await win.webContents.insertText('r')
    await sleep(200)
    record('typing «r» in a field types it and reloads nothing [negative control]', served['/'] === 5 && (await js("document.querySelector('#field').value")) === 'r', JSON.stringify(served))

    // A reload is also something a person can FIND: the right-click menu offers it.
    const template = chrome ? chrome.menuTemplate(win, { isEditable: false, selectionText: '' }, { shell }) : []
    const labels = template.filter(i => i.label).map(i => i.label)
    record('the right-click menu offers Back, Forward, Reload — and the way to the browser', JSON.stringify(labels) === JSON.stringify(['Back', 'Forward', 'Reload', 'Open in your browser']), JSON.stringify(labels))
    const item = label => template.find(i => i.label === label) || {}
    record('with nowhere to go back to, Back is offered disabled', item('Back').enabled === false && item('Forward').enabled === false)
    if (item('Reload').click) item('Reload').click()
    await sleep(500)
    record('choosing Reload reloads the page', served['/'] === 6, JSON.stringify(served))
    // A page of the house that this window cannot finish — a passkey ceremony with a key that asks for a PIN — is one
    // right-click away from the browser, at the address it is on (greenhouse decisions/0566).
    await win.loadURL(origin + '/second?invite=abc'); await sleep(300)
    const there = chrome ? chrome.menuTemplate(win, {}, { shell }).find(i => i.label === 'Open in your browser') : null
    if (there && there.click) there.click()
    await sleep(100)
    record('«Open in your browser» hands the browser the page the window is on', JSON.stringify(browsed) === JSON.stringify([origin + '/second?invite=abc']), JSON.stringify(browsed))
    const noShell = chrome ? chrome.menuTemplate(win, {}).filter(i => i.label).map(i => i.label) : []
    record('a window given no way to the browser does not offer one [negative control]', JSON.stringify(noShell) === JSON.stringify(['Back', 'Forward', 'Reload']), JSON.stringify(noShell))
    await win.loadURL(origin + '/'); await sleep(300)
    served['/'] -= 1; served['/second'] -= 1   // the two loads above are this block's own
    const inField = chrome ? chrome.menuTemplate(win, { isEditable: true, selectionText: '' }).map(i => i.role).filter(Boolean) : []
    record('in a field the menu offers cut, copy and paste first', JSON.stringify(inField) === JSON.stringify(['cut', 'copy', 'paste']), JSON.stringify(inField))

    await win.loadURL(origin + '/second'); await sleep(300)
    await key('Left', ['alt'])
    record('Alt+Left goes back', (await js("document.querySelector('#at').textContent")) === '/', await js('location.pathname'))
    await key('Right', ['alt'])
    record('Alt+Right goes forward', (await js("document.querySelector('#at').textContent")) === '/second', await js('location.pathname'))

    // The bridge runs docker and gpg; the panel shows what a resident built. Reloading must not change who gets it.
    record('the panel\'s page is never handed the Desktop\'s bridge, before or after a reload', (await js('typeof window.milpa')) === 'undefined')
    await win.loadFile(path.join(ROOT, 'renderer', 'boot.html')); await sleep(400)
    record('the Desktop\'s own page still gets it [positive control]', (await js('typeof window.milpa')) === 'object')
    const onBoot = chrome ? chrome.menuTemplate(win, {}, { shell }).filter(i => i.label).map(i => i.label) : []
    record('the Desktop\'s own page is not offered to the browser: it is a file of this app [negative control]', !onBoot.includes('Open in your browser') && onBoot.includes('Reload'), JSON.stringify(onBoot))
  } catch (e) { record('harness ran without throwing', false, String(e)) }

  server.close()
  const failed = checks.filter(c => !c.ok)
  console.log('\n' + (checks.length - failed.length) + '/' + checks.length + ' window checks passed')
  app.exit(failed.length ? 1 : 0)
})
