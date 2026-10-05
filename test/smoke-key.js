// Headless smoke test, in real Electron, of a passkey ceremony with a security key that asks for a PIN (greenhouse
// decisions/0568): the REAL preload on a page served over http://localhost, the REAL main-side handler and PIN
// window, and a key that is a process (test/virtual-key.js) — a CTAP2 key with a PIN, which DevTools' virtual
// authenticator cannot be. The test types the PIN and clicks as a person would. Exits non-zero if any check fails.
//
// NO REAL KEY IS OPENED. The Desktop's client is told the software key by name (MILPA_SECURITY_KEYS), and Chromium's
// own WebAuthn is put on DevTools' virtual environment for the whole run, where it sees no USB device at all.
const { app, BrowserWindow, ipcMain } = require('electron')
const http = require('http')
const os = require('os')
const fs = require('fs')
const path = require('path')
const crypto = require('crypto')
const ROOT = path.join(__dirname, '..')
const { virtualKey } = require('./virtual-key.js')
const cbor = require(path.join(ROOT, 'security-key', 'cbor.js'))
const sleep = ms => new Promise(r => setTimeout(r, ms))
app.commandLine.appendSwitch('no-sandbox'); app.commandLine.appendSwitch('disable-gpu'); app.disableHardwareAcceleration()

const checks = []
function record (name, ok, detail) { checks.push({ name, ok: !!ok, detail }); console.log((ok ? 'PASS' : 'FAIL') + ' · ' + name + (ok || detail === undefined ? '' : ' — ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)))) }
setTimeout(() => { console.log('FAIL · the harness finished within three minutes'); app.exit(1) }, 180000)

const PAGE = `<!doctype html><meta charset="utf-8"><title>house</title><p id="at"></p><iframe id="inner" src="/frame"></iframe><script>
const b = (n) => crypto.getRandomValues(new Uint8Array(n))
const hex = (ab) => [...new Uint8Array(ab)].map(x => x.toString(16).padStart(2, '0')).join('')
const unhex = (h) => Uint8Array.from(h.match(/../g).map(x => parseInt(x, 16)))
window.results = {}
const settle = (tag, p, read) => { results[tag] = 'pending'; p.then(c => { results[tag] = Object.assign({ ok: true }, read(c)) }, e => { results[tag] = { ok: false, name: e && e.name, message: e && e.message } }) }
window.register = (tag, uv, more) => settle(tag, navigator.credentials.create({ publicKey: Object.assign({ rp: { id: 'localhost', name: 'Milpa' }, user: { id: b(16), name: 'operator', displayName: 'Operator' }, challenge: window.lastChallenge = b(32), pubKeyCredParams: [{ type: 'public-key', alg: -7 }], authenticatorSelection: { userVerification: uv || 'required', residentKey: 'discouraged' }, timeout: 60000 }, more || {}) }),
  c => ({ id: c.id, type: c.type, chromiums: c instanceof PublicKeyCredential, rawIsBuffer: c.rawId instanceof ArrayBuffer, rawId: hex(c.rawId), clientData: new TextDecoder().decode(c.response.clientDataJSON), clientDataHex: hex(c.response.clientDataJSON), attestationObject: hex(c.response.attestationObject), publicKey: hex(c.response.getPublicKey()), transports: c.response.getTransports(), json: JSON.stringify(c.toJSON()), challenge: hex(window.lastChallenge) }))
window.signin = (tag, ids) => settle(tag, navigator.credentials.get({ publicKey: { challenge: window.lastChallenge = b(32), rpId: 'localhost', allowCredentials: ids.map(id => ({ type: 'public-key', id: unhex(id) })), userVerification: 'required', timeout: 60000 } }),
  c => ({ rawId: hex(c.rawId), clientData: new TextDecoder().decode(c.response.clientDataJSON), clientDataHex: hex(c.response.clientDataJSON), authenticatorData: hex(c.response.authenticatorData), signature: hex(c.response.signature), challenge: hex(window.lastChallenge) }))
</script>`

app.whenReady().then(async () => {
  const server = http.createServer((req, res) => { res.writeHead(200, { 'Content-Type': 'text/html', 'Cache-Control': 'no-store' }); res.end(req.url.startsWith('/frame') ? '<!doctype html><title>frame</title>' : PAGE) })
  await new Promise(resolve => server.listen(0, resolve))
  const port = server.address().port
  const HOUSE = `http://localhost:${port}`       // the origin the Desktop declares to the house
  const ELSEWHERE = `http://127.0.0.1:${port}`    // the same server under a name that is not the house's
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mk-'))
  const key = await virtualKey().listen(path.join(dir, 'key'))
  const none = () => { process.env.MILPA_SECURITY_KEYS = '' }
  const plugged = (...keys) => { process.env.MILPA_SECURITY_KEYS = keys.map(k => k.path).join(',') }
  none()

  let desk = null
  try { desk = require(path.join(ROOT, 'security-key', 'desk.js')) } catch (e) { record('the Desktop has a client for a security key that asks for a PIN', false, String(e.message).split('\n')[0]) }
  // The keys are named (MILPA_SECURITY_KEYS, above and below) AND the places a key would be looked for are an empty
  // directory: whatever the code under test does — a mutant of it once went looking — it cannot reach a real key.
  const hid = desk ? require(path.join(ROOT, 'security-key', 'hid.js')) : null
  if (desk) desk.attach({ ipcMain, BrowserWindow, house: HOUSE, root: ROOT, discover: () => hid.keys({ sys: path.join(dir, 'nowhere'), dev: path.join(dir, 'nowhere') }) })

  // The REAL preload, told the house's origin the way main.js tells it.
  const prefs = { preload: path.join(ROOT, 'preload.js'), additionalArguments: [`--milpa-house=${HOUSE}`], contextIsolation: true, nodeIntegration: false }
  const win = new BrowserWindow({ width: 900, height: 700, show: true, webPreferences: prefs })
  const js = c => win.webContents.executeJavaScript(c)
  // Chromium's own WebAuthn on DevTools' virtual environment: it sees the authenticators added here and no USB device.
  const cdp = win.webContents.debugger
  cdp.attach('1.3'); await cdp.sendCommand('WebAuthn.enable')
  const chromiumKey = (verifies) => cdp.sendCommand('WebAuthn.addVirtualAuthenticator', { options: { protocol: 'ctap2', transport: 'usb', hasResidentKey: false, hasUserVerification: verifies, isUserVerified: verifies, automaticPresenceSimulation: true } })
  const result = async (tag, wait = 8000) => { for (const end = Date.now() + wait; Date.now() < end;) { const r = await js(`results[${JSON.stringify(tag)}]`); if (r && r !== 'pending') return r; await sleep(50) } return js(`results[${JSON.stringify(tag)}]`) }

  // The Desktop's PIN window, driven as a person drives it.
  const pinWindow = () => BrowserWindow.getAllWindows().find(w => !w.isDestroyed() && /\/renderer\/key\.html$/.test(w.webContents.getURL()))
  const shown = async (step, wait = 6000) => {
    for (const end = Date.now() + wait; Date.now() < end;) {
      const w = pinWindow()
      if (w) { const v = await w.webContents.executeJavaScript("({ step: document.querySelector('#key').dataset.step, text: document.body.innerText, pinVisible: !document.querySelector('#key-form').hidden, field: document.querySelector('#key-pin').value, type: document.querySelector('#key-pin').type, bridge: Object.keys(window.milpaKey || {}).sort().join(), milpa: typeof window.milpa })").catch(() => null); if (v && (!step || v.step === step)) return v }
      await sleep(50)
    }
    return null
  }
  const gone = async (wait = 4000) => { for (const end = Date.now() + wait; Date.now() < end;) { if (!pinWindow()) return true; await sleep(50) } return false }
  const type = async (pin) => { const w = pinWindow(); await w.webContents.executeJavaScript("document.querySelector('#key-pin').focus()"); await w.webContents.insertText(pin); await sleep(100); await w.webContents.executeJavaScript("document.querySelector('#key-go').click()") }
  const click = (sel) => pinWindow().webContents.executeJavaScript(`document.querySelector(${JSON.stringify(sel)}).click()`)
  const sent = (what) => key.said().filter(s => s === what).length
  const sha256 = (b) => crypto.createHash('sha256').update(b).digest()

  try {
    await win.loadURL(HOUSE + '/'); await sleep(300)
    record('the house\'s page is not handed the Desktop\'s bridge, nor the PIN window\'s [control]', (await js('typeof window.milpa + "," + typeof window.milpaKey + "," + typeof window.raw')) === 'undefined,undefined,undefined')
    const leaked = await js("Object.getOwnPropertyNames(window).filter(n => /milpa|webauthn|ipc|electron/i.test(n)).join()")
    record('…and nothing else of the Desktop is left on it', leaked === '', leaked)
    record('navigator.credentials on the house\'s page is the client\'s own function, not a script\'s', /\[native code\]/.test(await js('String(navigator.credentials.create)')) && /\[native code\]/.test(await js('String(navigator.credentials.get)')), await js('String(navigator.credentials.create)'))

    // ── no key that needs its PIN asked: Chromium's ceremony, as before ──
    const selfVerifying = await chromiumKey(true)
    await js("register('uv')")
    const uv = await result('uv')
    record('a key that verifies its user by itself still registers through Chromium — its own PublicKeyCredential — and no PIN window opens', uv && uv.ok === true && uv.chromiums === true && uv.rawIsBuffer === true && JSON.parse(uv.clientData).origin === HOUSE && !pinWindow(), uv)
    await cdp.sendCommand('WebAuthn.removeVirtualAuthenticator', selfVerifying)
    const plain = await chromiumKey(false)
    await js("register('chromium-alone')")
    const alone = await result('chromium-alone')
    record('Chromium by itself still cannot: a key that does not verify its user is refused when the house requires it [control — evidence/1100, arm B]', alone && alone.ok === false && alone.name === 'NotAllowedError', alone)
    await cdp.sendCommand('WebAuthn.removeVirtualAuthenticator', plain)

    // ── a key with a PIN: the Desktop's ceremony ──
    plugged(key)
    await js("register('wrong-then-right')")
    let v = await shown('pin')
    record('a key with a PIN is plugged in: the Desktop opens its own window and asks for the PIN', !!v && v.pinVisible && v.type === 'password', v)
    record('…it says who is asking, what for, and how many attempts the key has left', !!v && v.text.includes(HOUSE + ' asks to register a security key.') && /8 attempts left\./.test(v.text), v && v.text)
    record('…and that window is handed two verbs and nothing of the Desktop\'s bridge', !!v && v.bridge === 'close,onView,pin' && v.milpa === 'undefined', v && [v.bridge, v.milpa])
    await type('0000')
    v = await shown('pin')
    await sleep(1500)   // long enough for anything that would try again by itself to have done so
    const again = await shown('pin')
    record('a wrong PIN reached the key ONCE — and a second and a half later, still once', sent('clientPin:pinTokenWithPermissions') === 1 && key.retries === 7, { said: key.said(), retries: key.retries })
    record('…the window says the key refused it, that it was not tried again, and that 7 attempts are left', !!again && /refused that PIN/.test(again.text) && /not tried again/.test(again.text) && /7 attempts left\./.test(again.text) && again.field === '', again && again.text)
    record('…and the page is still waiting: it was told nothing', (await js("results['wrong-then-right']")) === 'pending')
    await type('1234')
    const made = await result('wrong-then-right')
    record('the right PIN, typed: the key registers and the page gets its credential', made && made.ok === true && made.rawIsBuffer && key.credentials.has(made.rawId) && key.retries === 8 && await gone(), made)
    const att = made && made.ok ? cbor.decode(Buffer.from(made.attestationObject, 'hex')) : new Map()
    const authData = att.get('authData') || Buffer.alloc(64)
    const clientData = made && made.ok ? JSON.parse(made.clientData) : {}
    record('…signed over this page\'s origin and this request\'s challenge, with the user verified', clientData.origin === HOUSE && clientData.type === 'webauthn.create' && Buffer.from(clientData.challenge || '', 'base64url').toString('hex') === made.challenge && (authData[32] & 0x05) === 0x05 && authData.subarray(0, 32).equals(sha256(Buffer.from('localhost'))), clientData)
    record('…in the shape a page reads: toJSON, transports, the public key', made && made.ok && JSON.parse(made.json).response.attestationObject === Buffer.from(made.attestationObject, 'hex').toString('base64url') && made.transports.join() === 'usb' && made.publicKey.length > 100 && made.type === 'public-key')

    await js(`signin('in', ['${crypto.randomBytes(32).toString('hex')}', '${made.rawId}'])`)
    v = await shown('pin')
    record('signing in: the window says so', !!v && v.text.includes(HOUSE + ' asks you to sign in with your security key.'), v && v.text)
    await type('1234')
    const signed = await result('in')
    const publicKey = made && made.ok ? crypto.createPublicKey({ key: Buffer.from(made.publicKey, 'hex'), format: 'der', type: 'spki' }) : null
    record('…and the key\'s signature verifies under the key it registered, over this origin and challenge, user verified', signed && signed.ok && signed.rawId === made.rawId && JSON.parse(signed.clientData).origin === HOUSE && Buffer.from(JSON.parse(signed.clientData).challenge, 'base64url').toString('hex') === signed.challenge && (Buffer.from(signed.authenticatorData, 'hex')[32] & 0x05) === 0x05 &&
      crypto.verify('sha256', Buffer.concat([Buffer.from(signed.authenticatorData, 'hex'), sha256(Buffer.from(signed.clientDataHex, 'hex'))]), publicKey, Buffer.from(signed.signature, 'hex')), signed)

    // ── the PIN does not stay anywhere it can be read back ──
    const held = await virtualKey({ touch: 'manual' }).listen(path.join(dir, 'held'))
    plugged(held)
    await js("register('held')")
    await shown('pin'); await type('1234')
    v = await shown('touch')
    record('once sent, the PIN is not in its field any more — while the window says «Touch your security key»', !!v && /Touch your security key\./.test(v.text) && v.field === '' && !v.pinVisible, v)
    held.touch()
    const heldMade = await result('held')
    record('…and the touch finishes it', heldMade && heldMade.ok === true && held.credentials.size === 1 && await gone(), heldMade)
    await held.close(); plugged(key)

    // ── saying no ──
    let before = key.log.length
    await js("register('cancelled')")
    await shown('pin'); await click('#key-close')
    const cancelled = await result('cancelled')
    record('Cancel: the page is told what a browser tells it, the window is gone, and the key was sent no PIN', cancelled && cancelled.ok === false && cancelled.name === 'NotAllowedError' && /timed out or was not allowed/.test(cancelled.message) && await gone() && !key.said().slice(before).some(s => /pinToken|makeCredential/.test(s)), [cancelled, key.said().slice(before)])
    await js("register('first'); register('second')")
    await shown('pin')
    const second = await result('second')
    record('one ceremony at a time: a second request while the window is open is refused, and opens no second window', second && second.ok === false && second.name === 'NotAllowedError' && BrowserWindow.getAllWindows().filter(w => /key\.html$/.test(w.webContents.getURL())).length === 1, second)
    await win.webContents.reload(); await sleep(600)
    record('the page that asked is reloaded: its ceremony ends and the PIN window closes with it', await gone())

    // ── a PIN typed into nothing: the field is a password field and its value does not outlive the submit ──
    await js("register('es')")
    await shown('pin')
    await pinWindow().webContents.executeJavaScript("window.milpaI18n.setLocale('es')"); await sleep(150)
    v = await shown('pin')
    record('Spanish is a choice: the same window, from the catalog', !!v && /pide registrar una llave de seguridad/.test(v.text) && /Quedan 8 intentos\./.test(v.text), v && v.text)
    await pinWindow().webContents.executeJavaScript("window.milpaI18n.setLocale('en')")
    await type('12')
    v = await shown('pin'); await sleep(200); v = await shown('pin')
    record('two characters are not a PIN: the window says it was not sent, and the key was not', !!v && /was not sent to the key/.test(v.text) && /8 attempts left/.test(v.text) && key.retries === 8, v && v.text)
    await click('#key-close'); await result('es')

    // ── who may ask ──
    before = key.log.length
    await win.loadURL(ELSEWHERE + '/'); await sleep(300)
    const theirs = await js('navigator.credentials.create.name + "," + navigator.credentials.get.name')
    await js("register('elsewhere')"); await sleep(1200)
    record('a page that is not the house\'s gets Chromium\'s own navigator.credentials: no PIN window, and the key is not spoken to [negative control]', theirs === 'create,get' && !pinWindow() && key.log.length === before, [theirs, key.said().slice(before)])

    const probe = new BrowserWindow({ width: 600, height: 400, show: true, webPreferences: { preload: path.join(__dirname, 'smoke-key-preload.js'), contextIsolation: true, nodeIntegration: false, nodeIntegrationInSubFrames: true, sandbox: false } })
    const pjs = c => probe.webContents.executeJavaScript(c)
    const REQ = "{ kind: 'create', publicKey: { rp: { id: 'localhost', name: 'Milpa' }, user: { id: 'AAAAAAAAAAAAAAAAAAAAAA', name: 'operator' }, challenge: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA', pubKeyCredParams: [{ type: 'public-key', alg: -7 }], authenticatorSelection: { userVerification: 'required' } } }"
    await probe.loadURL(ELSEWHERE + '/'); await sleep(300)
    const foreign = await pjs(`window.raw.webauthn(${REQ})`)
    record('main\'s own lock: another origin handed the channel raw is refused before any key is spoken to [negative control]', foreign && foreign.error && foreign.error.name === 'NotAllowedError' && !foreign.credential && !foreign.native && !pinWindow() && key.log.length === before, foreign)
    const claimed = await pjs(`window.raw.webauthn(Object.assign(${REQ}, { origin: '${HOUSE}' }))`)
    record('…also when it says it is the house [negative control]', claimed && claimed.error && !pinWindow() && key.log.length === before, claimed)
    await probe.loadURL(HOUSE + '/'); await sleep(400)
    const inner = probe.webContents.mainFrame.frames[0]
    const framed = inner ? await inner.executeJavaScript(`window.raw.webauthn(${REQ})`) : null
    record('…and a frame inside a page of the house is refused too: only the top frame may ask [negative control]', !!inner && new URL(inner.url).origin === HOUSE && framed && framed.error && framed.error.name === 'NotAllowedError' && !pinWindow() && key.log.length === before, framed)
    pjs(`window.raw.webauthn(${REQ}).then(r => { window.rawResult = r })`)
    v = await shown('pin')
    record('the top frame of a page of the house, over the same raw channel, is served — so the refusals above are main\'s, not a broken harness [positive control]', !!v && v.pinVisible)
    before = key.log.length
    await pjs("window.raw.keyAnswer({ pin: '1234' })"); await sleep(700)
    v = await shown('pin')
    record('a page cannot answer for the PIN window: a PIN sent from the page is not taken, and the key is sent nothing [negative control]', !!v && v.pinVisible && !key.said().slice(before).some(s => /pinToken|keyAgreement/.test(s)), key.said().slice(before))
    await pjs("window.raw.keyAnswer({ close: true })"); await sleep(400)
    record('…nor close it', !!pinWindow())
    probe.destroy(); await sleep(300)
    record('the window that asked is closed: the PIN window goes with it', await gone())
  } catch (e) { record('harness ran without throwing', false, String(e && e.stack || e)) }

  const failed = checks.filter(c => !c.ok)
  console.log('\n' + (checks.length - failed.length) + '/' + checks.length + ' security-key window checks passed')
  try { await key.close(); fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  app.exit(failed.length ? 1 : 0)
})
