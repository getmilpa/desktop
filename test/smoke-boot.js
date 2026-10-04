// Headless smoke test for the Desktop's boot screen (renderer/boot.html) — what the window says while the house comes
// up, before it becomes the house's own panel (greenhouse evidence/1091, E3 and E6). A fixture bridge moves the phase;
// the test types and clicks as a person would. Exits non-zero if any check fails.
const { app, BrowserWindow } = require('electron')
const { execFileSync } = require('child_process')
const path = require('path')
const ROOT = path.join(__dirname, '..')
const sleep = ms => new Promise(r => setTimeout(r, ms))
app.commandLine.appendSwitch('no-sandbox'); app.commandLine.appendSwitch('disable-gpu'); app.disableHardwareAcceleration()

const RUN = 'docker exec -it milpa-desktop-backend php bin/coa'
const checks = []
function record (name, ok, detail) { checks.push({ name, ok: !!ok, detail }); console.log((ok ? 'PASS' : 'FAIL') + ' · ' + name + (ok || !detail ? '' : ' — ' + detail)) }

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1100, height: 800, show: true, webPreferences: { preload: path.join(__dirname, 'smoke-boot-preload.js'), contextIsolation: true, sandbox: false } })
  const js = c => win.webContents.executeJavaScript(c)
  const text = () => js('document.body.innerText')
  const visible = sel => js(`(function(){var e=document.querySelector(${JSON.stringify(sel)});return !!e && !e.closest('[hidden]')})()`)
  const tick = () => sleep(1700)   // > one boot.js poll (1.5 s)
  const type = async (sel, value) => {
    await js(`(function(){var i=document.querySelector(${JSON.stringify(sel)});i.focus();i.value='';i.dispatchEvent(new Event('input',{bubbles:true}));})()`)
    if (value !== '') await win.webContents.insertText(value)
    await sleep(150)
  }
  const typeAndOpen = async (value, button = '#boot-open') => {
    await type('#boot-link', value)
    await js(`document.querySelector(${JSON.stringify(button)}).click()`); await sleep(200)
  }
  // What the boot screen offers to be copied as the founding command — and whether it says it is one.
  const found = () => js("(function(){var c=document.querySelector('#cmd-found');return {text:c.textContent,ready:c.dataset.ready}})()")
  const found2 = async (domain, objective) => { await type('#found-domain', domain); await type('#found-objective', objective); return found() }
  // The command as a shell reads it: the same words after `php bin/coa`, one per line — so the quoting is measured
  // by a shell, not by a regex that agrees with the code that wrote it.
  const asAShellReadsIt = (cmd) => execFileSync('sh', ['-c', cmd.replace(RUN, "printf '%s\\n'")], { encoding: 'utf8' }).trimEnd().split('\n')
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

    // L2 (greenhouse evidence/1100): the screen printed `foundation:found --domain="…" --objective="…" --sign`, Rod
    // copied it as it stood and the house was founded with «…». Nothing on this screen is a command with a marker in it.
    record('up, no panel: no marker is printed anywhere on the screen (L2)', !/…"|"…|\.\.\."|<[a-z ]+>/.test(t1.replace('Starting the house…', '')), t1.slice(0, 400))
    let f = await found()
    record('before anything is typed, what stands where the command will be is not a command', f.ready === 'false' && !/foundation:found|docker exec/.test(f.text), JSON.stringify(f))
    f = await found2('a blog for our team', '')
    record('a domain alone is not a command yet', f.ready === 'false' && !/foundation:found/.test(f.text), JSON.stringify(f))
    f = await found2('…', 'publish what the team writes')
    record('a domain of «…» is not a command either [negative control]', f.ready === 'false' && !/foundation:found/.test(f.text), JSON.stringify(f))
    f = await found2('a blog for our team', '  ...  ')
    record('nor an objective of dots [negative control]', f.ready === 'false' && !/foundation:found/.test(f.text), JSON.stringify(f))
    f = await found2('a blog for our team', 'publish what the team writes')
    record('both fields filled: the command appears, with what was typed and the docker exec it is typed with',
      f.ready === 'true' && f.text === RUN + " foundation:found --domain='a blog for our team' --objective='publish what the team writes' --sign", JSON.stringify(f))
    await tick()
    record('…and it is still there after the screen polls the house again', JSON.stringify(await found()) === JSON.stringify(f))
    const hard = ["Rod's blog: \"posts\" & $HOME `id` \\ ; rm -rf ~", 'publicar — lo que el equipo escribe']
    f = await found2(hard[0], hard[1])
    let read = []
    try { read = asAShellReadsIt(f.text) } catch (e) { read = [String(e.message)] }
    record('a shell reads the command as exactly the two things typed, quotes and all',
      JSON.stringify(read) === JSON.stringify(['foundation:found', '--domain=' + hard[0], '--objective=' + hard[1], '--sign']), JSON.stringify(read))
    f = await found2('', '')
    record('emptied again, the command is gone', f.ready === 'false' && !/foundation:found/.test(f.text), JSON.stringify(f))

    // L1 (evidence/1100): this window cannot ask for a security key's PIN, so the one-time link opens in the browser.
    await typeAndOpen('https://evil.example/webauthn/enroll?invite=x')
    record('a link of another origin is refused on the page and never reaches main [negative control]',
      (await js('window.milpa.bootBrowsed().length + window.milpa.bootOpened().length')) === 0 && /not this house/.test(await js("document.querySelector('#boot-link-error').textContent")))
    await typeAndOpen('https://evil.example/webauthn/enroll?invite=x', '#boot-open-here')
    record('…by either button [negative control]', (await js('window.milpa.bootBrowsed().length + window.milpa.bootOpened().length')) === 0)
    const LINK = 'http://localhost:8899/webauthn/enroll?invite=abc&next=%2Fmilpa%2Fadmin'
    await typeAndOpen(LINK)
    record('a link of this house is handed to main to open in the BROWSER — where a key\'s PIN can be asked',
      JSON.stringify(await js('window.milpa.bootBrowsed()')) === JSON.stringify([LINK]) && (await js('window.milpa.bootOpened().length')) === 0)
    await typeAndOpen(LINK, '#boot-open-here')
    record('«Open here» still opens it in the window', JSON.stringify(await js('window.milpa.bootOpened()')) === JSON.stringify([LINK]) && (await js('window.milpa.bootBrowsed().length')) === 1)
    record('the screen says why: a key that asks for a PIN works in the browser, not in this window', /PIN/.test(await text()) && /browser/.test(await text()))

    await js("window.milpa.bootSet({ phase: 'up', panel: true })"); await tick()
    record('panel enabled: «Open the panel in your browser» is offered', await visible('#boot-panel'))
    record('panel enabled: the paste box STAYS — enabling the panel is what prints the one-time link', await visible('#boot-link'))
    await js("document.querySelector('#boot-panel').click()"); await sleep(200)
    record('«Open the panel in your browser» opens the house\'s sign-in, back to the panel, in the browser', (await js('window.milpa.bootBrowsed()')).pop() === 'http://localhost:8899/webauthn/signin?next=%2Fmilpa%2Fadmin' && (await js('window.milpa.bootOpened().length')) === 1)
    await js("document.querySelector('#boot-panel-here').click()"); await sleep(200)
    record('«Open it in this window» opens it here', (await js('window.milpa.bootOpened()')).pop() === 'http://localhost:8899/webauthn/signin?next=%2Fmilpa%2Fadmin')

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
