// Regression: Electron 38 can dereference a destroyed modal parent on Linux.
// No Milpa backend, credential, physical device or network is used.
// Apache-2.0 · (c) Rodrigo Vicente - TeamX Agency
const { app, BrowserWindow } = require('electron')
app.commandLine.appendSwitch('no-sandbox')
app.disableHardwareAcceleration()
const deadline = setTimeout(() => { console.error('FAIL · modal lifetime did not settle'); app.exit(1) }, 10000)
app.whenReady().then(async () => {
  const parent = new BrowserWindow({ show: true })
  await parent.loadURL('data:text/html,parent')
  const child = new BrowserWindow({ parent, modal: true, show: true })
  await child.loadURL('data:text/html,modal')
  // Exercise native lifetime after the window has reached the event loop.
  await new Promise(resolve => setTimeout(resolve, 500))
  parent.destroy()
  // Let native close notifications run. Returning from destroy() alone misses the crash.
  setTimeout(() => {
    const passed = parent.isDestroyed()
    // Electron does not promise to destroy the child here. A surviving modal
    // must stop dereferencing its former parent during native visibility changes.
    if (!child.isDestroyed()) { child.hide(); child.show(); child.destroy() }
    console.log((passed ? 'PASS' : 'FAIL') + ' · a modal child survives parent destruction without a native crash')
    clearTimeout(deadline)
    app.exit(passed ? 0 : 1)
  }, 500)
}).catch(error => { console.error(error); app.exit(1) })
