// Headless smoke test for the Desktop's boot screen (renderer/boot.html) — what the window says while the house comes
// up, before it becomes the house's own panel (greenhouse evidence/1091, E3 and E6). A fixture bridge moves the phase;
// the test types and clicks as a person would. Exits non-zero if any check fails.
const { app, BrowserWindow } = require('electron')
const path = require('path')
const ROOT = path.join(__dirname, '..')
const sleep = ms => new Promise(r => setTimeout(r, ms))
app.commandLine.appendSwitch('no-sandbox'); app.commandLine.appendSwitch('disable-gpu'); app.disableHardwareAcceleration()

const checks = []
function record (name, ok, detail) { checks.push({ name, ok: !!ok, detail }); console.log((ok ? 'PASS' : 'FAIL') + ' · ' + name + (ok || !detail ? '' : ' — ' + detail)) }

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1100, height: 800, show: true, webPreferences: { preload: path.join(__dirname, 'smoke-boot-preload.js'), contextIsolation: true, sandbox: false } })
  const js = c => win.webContents.executeJavaScript(c)
  const text = () => js('document.body.innerText')
  const visible = sel => js(`(function(){var e=document.querySelector(${JSON.stringify(sel)});return !!e && !e.closest('[hidden]')})()`)
  const tick = () => sleep(1700)   // > one boot.js poll (1.5 s)
  const typeAndOpen = async (value) => {
    await js(`(function(){var i=document.querySelector('#boot-link');i.focus();i.value='';})()`)
    await win.webContents.insertText(value)
    await js("document.querySelector('#boot-open').click()"); await sleep(200)
  }
  try {
    await win.loadFile(path.join(ROOT, 'renderer', 'boot.html')); await sleep(400)
    const t0 = await text()
    record('starting: English by default, the house is starting', /Starting the house…/.test(t0), t0.slice(0, 120))
    record('starting: no hard-coded Spanish left (E6)', !/levantando|puesto de trabajo/i.test(t0), t0.slice(0, 120))

    await js("window.milpa.bootSet({ phase: 'up', panel: false })"); await tick()
    const t1 = await text()
    record('up, no panel: says where the house answers', /The house is up at http:\/\/localhost:8899/.test(t1), t1.slice(0, 160))
    record('up, no panel: the commands carry the docker exec they are typed with (E5)', /docker exec -it milpa-desktop-backend php bin\/coa capabilities:enable milpa\/admin --sign/.test(t1))
    record('up, no panel: the paste box is offered', await visible('#boot-link'))

    await typeAndOpen('https://evil.example/webauthn/enroll?invite=x')
    record('a link of another origin is refused on the page and never reaches main [negative control]',
      (await js('window.milpa.bootOpened().length')) === 0 && /not this house/.test(await js("document.querySelector('#boot-link-error').textContent")))
    await typeAndOpen('http://localhost:8899/webauthn/enroll?invite=abc&next=%2Fmilpa%2Fadmin')
    record('a link of this house is handed to main to open in the window',
      JSON.stringify(await js('window.milpa.bootOpened()')) === JSON.stringify(['http://localhost:8899/webauthn/enroll?invite=abc&next=%2Fmilpa%2Fadmin']))

    await js("window.milpa.bootSet({ phase: 'up', panel: true })"); await tick()
    record('panel enabled: «Open the panel» is offered', await visible('#boot-panel'))
    record('panel enabled: the paste box STAYS — enabling the panel is what prints the one-time link', await visible('#boot-link'))
    await js("document.querySelector('#boot-panel').click()"); await sleep(200)
    record('«Open the panel» opens the house\'s sign-in, back to the panel', (await js('window.milpa.bootOpened()')).pop() === 'http://localhost:8899/webauthn/signin?next=%2Fmilpa%2Fadmin')

    // the fixture bridge is re-created on a reload (it is a preload), so the phase is set again after it
    await js("localStorage.setItem('milpa.locale','es')"); await win.reload(); await sleep(400)
    await js("window.milpa.bootSet({ phase: 'up', panel: true })"); await tick()
    record('Spanish is a choice, not the default', /La casa responde en http:\/\/localhost:8899/.test(await text()))
    await js("window.milpaI18n.setLocale('en')")

    await js("window.milpa.bootSet({ phase: 'failed', error: 'the house did not answer on http://127.0.0.1:8899 — docker logs milpa-desktop-backend' })"); await tick()
    const t3 = await text()
    record('failed: says the house did not start, and why', /The house did not start/.test(t3) && /docker logs milpa-desktop-backend/.test(t3), t3.slice(0, 200))
  } catch (e) { record('harness ran without throwing', false, String(e)) }

  const failed = checks.filter(c => !c.ok)
  console.log('\n' + (checks.length - failed.length) + '/' + checks.length + ' boot checks passed')
  app.exit(failed.length ? 1 : 0)
})
