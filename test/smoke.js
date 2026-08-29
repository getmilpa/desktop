// Headless smoke test for the Milpa Desktop renderer. Loads renderer/index.html with a fixture bridge,
// drives the UI, and ASSERTS the four surfaces render — exits non-zero if any check fails.
const { app, BrowserWindow } = require('electron')
const fs = require('fs'); const path = require('path')
const ROOT = path.join(__dirname, '..')
const SHOTS = path.join(__dirname, 'screenshots')
const sleep = ms => new Promise(r => setTimeout(r, ms))
app.commandLine.appendSwitch('no-sandbox'); app.commandLine.appendSwitch('disable-gpu'); app.disableHardwareAcceleration()

const checks = []
function record (name, ok, detail) { checks.push({ name, ok: !!ok, detail }); console.log((ok ? 'PASS' : 'FAIL') + ' · ' + name + (ok || !detail ? '' : ' — ' + detail)) }

app.whenReady().then(async () => {
  try { fs.mkdirSync(SHOTS, { recursive: true }) } catch {}
  const win = new BrowserWindow({ width: 1320, height: 840, show: true, webPreferences: { preload: path.join(__dirname, 'smoke-preload.js'), contextIsolation: true, sandbox: false, backgroundThrottling: false } })
  const js = c => win.webContents.executeJavaScript(c)
  const shot = async n => { try { const img = await win.webContents.capturePage(); fs.writeFileSync(path.join(SHOTS, n), img.toPNG()) } catch {} }
  try {
    await win.loadFile(path.join(ROOT, 'renderer', 'index.html'))
    await sleep(700)
    record('loader: 13 grains', await js("document.querySelectorAll('.milpa-loader .grano').length") === 13)
    record('loader: booting while runtime comes up', await js("!!document.querySelector('#auth-screen.booting')"))
    await shot('1-loader.png')
    await sleep(2600)
    record('loader: settles when ready', await js("!!document.querySelector('#auth-screen') && !document.querySelector('#auth-screen.booting')"))
    record('token chip shows window tokens', await js("(document.querySelector('#st-tokens')||{}).textContent||''").then(t => /en ventana/.test(t)), 'chip empty')
    await js("document.querySelector('#auth-open') && document.querySelector('#auth-open').click()"); await sleep(900)
    record('app entered', await js("!!document.querySelector('.app') && !document.querySelector('.app').hidden"))
    // polish (Rod's macOS review): the logo and nav icons must actually render — not placeholder glyphs.
    record('brand: the Milpa M mark is an SVG', await js("!!document.querySelector('.mui-sidebar__brand svg.milpa-mark rect')"))
    record('nav icons render as SVG (not tofu glyphs)', await js("document.querySelectorAll('.mui-sidebar__item-icon svg').length") >= 4)
    record('no leftover bordered-box glyph icons in the nav', await js("document.querySelectorAll('.mui-sidebar__item-icon.wf-box').length") === 0)
    await js("var t=document.querySelector('[data-tab=\"contexto\"]'); t && t.click()"); await sleep(600)
    record('context fill bar renders a %', await js("((document.querySelector('#ctx-fill')||{}).innerHTML||'')").then(h => /%/.test(h)), 'no fill bar')
    await shot('2-context.png')
    await js("var s=document.querySelector('#st-identity'); s && s.click()"); await sleep(600)
    record('identity panel has a revoke button', await js("!!document.querySelector('[data-revoke]')"))
    await shot('3-identity.png')
    await js("var c=document.querySelector('#id-close'); c && c.click(); var n=document.querySelector('[data-nav=\"decisiones\"]'); n && n.click()"); await sleep(600)
    record('decisiones: pending gate actions', await js("!!document.querySelector('#dec-gate-actions [data-dd]')"))
    record('decisiones: session decisions rendered', await js("!document.querySelector('[data-screen=\"decisiones\"]').hidden && /Enrolar consume/.test(document.querySelector('[data-screen=\"decisiones\"]').textContent)"))
    await shot('4-decisiones.png')
    await js("var n=document.querySelector('[data-nav=\"capacidades\"]'); n && n.click()"); await sleep(700)
    record('capacidades: installed listed', await js("/milpa\\/agent/.test(document.querySelector('[data-screen=\"capacidades\"]').textContent)"))
    record('capacidades: enable button present', await js("!!document.querySelector('[data-enable]')"))
    await shot('5-capacidades.png')
    // BUG 1 (greenhouse decisions/0132): a turn that ENDS IN A QUESTION must not freeze Conversación on «pensando».
    // The fixture models it: the stream carries session.question_asked and drive() never resolves. The fix parks
    // the bubble out of «pensando» from the EVENT STREAM, not from drive returning.
    await js("var n=document.querySelector('[data-nav=\"sesiones\"]'); n && n.click()"); await sleep(400)
    await js("var q=document.querySelector('#query'); if(q){q.value='hazme un blog sobre X'} var s=document.querySelector('#send'); s && s.click()")
    await sleep(1800) // > one poll cycle (1200ms) so the stream's question_asked is seen
    const parked = await js("(function(){var b=document.querySelectorAll('.msg-agent'); b=b[b.length-1]; return b?b.textContent:''})()")
    record('conversation: a parked turn leaves the thinking state and points to Decisions', !/thinking|pensando/.test(parked) && /question pending|Decisions/i.test(parked), 'bubble=' + parked.replace(/\s+/g,' ').slice(0, 70))
    await shot('6-conversacion-parked.png')
    // STATUS RESET: a turn that RESOLVES (no gate) must leave the live chip at «En vivo», not stuck «Trabajando…».
    await js("var q=document.querySelector('#query'); if(q){q.value='termina la vuelta, listo'} var s=document.querySelector('#send'); s && s.click()")
    await sleep(1000)
    const live = await js("(document.querySelector('#st-live')||{}).textContent||''")
    record('status: the live chip resets to «Live» after a resolved turn (not stuck «Working»)', /Live/.test(live) && !/Working|Trabajando/.test(live), 'live=' + live.trim())
    await shot('7-status-reset.png')
    // i18n (decisions/0138): English is the default; Spanish is a first-class option via the locale switch.
    record('i18n: the nav renders in English by default', await js("(document.querySelector('[data-i18n=\"nav.sessions\"]')||{}).textContent") === 'Sessions')
    await js("window.milpaI18n && window.milpaI18n.setLocale('es')"); await sleep(200)
    record('i18n: switching to es renders the nav in Spanish', await js("(document.querySelector('[data-i18n=\"nav.sessions\"]')||{}).textContent") === 'Sesiones')
    await js("window.milpaI18n && window.milpaI18n.setLocale('en')"); await sleep(200)
    record('i18n: switching back to en restores English', await js("(document.querySelector('[data-i18n=\"nav.sessions\"]')||{}).textContent") === 'Sessions')
    await shot('8-i18n-en.png')
    // REMOTE component hosted in the shell (greenhouse decisions/0148): the Desktop hosts a Milpa live
    // web component wired for the REMOTE runtime (a milpa-live-boot + a signed <script data-milpa-state>),
    // and its action round-trips to the backend THROUGH THE BRIDGE — the renderer is file://, so the
    // remote runtime's POST is routed via window.MilpaLive.transport → IPC (main → container), not a
    // cross-origin fetch. The fixture bridge stands in for the container's LiveEndpoint.
    await js("var n=document.querySelector('[data-nav=\"componentes\"]'); n && n.click()"); await sleep(500)
    record('components: the Desktop hosts a REMOTE-wired live component (boot + signed data-milpa-state + metric card)', await js("!!document.querySelector('#component-host script[data-milpa-state=\"pipeline-table\"]') && !!document.querySelector('#component-host #milpa-live-boot') && /context tokens|6\\.8k/.test((document.querySelector('#component-host')||{}).textContent||'')"))
    await shot('9-component-host.png')
    const liveComp = await js("(async () => {\n" +
      "  const host = document.querySelector('#component-host');\n" +
      "  const root = host && host.querySelector('[x-data^=\"milpaDataTable\"]');\n" +
      "  const nonceOf = () => { const s = host && host.querySelector('script[data-milpa-state=\"pipeline-table\"]'); return s ? ((s.textContent||'').match(/sig-nonce=\"([a-z0-9]+)\"/)||[])[1] : null; };\n" +
      "  if (!window.Alpine) return { loaded: false };\n" +
      "  const transportSet = !!(window.MilpaLive && typeof window.MilpaLive.transport === 'function');\n" +
      "  if (!root) return { loaded: true, hydrated: false };\n" +
      "  let data; try { data = window.Alpine.$data(root); } catch (e) { return { loaded: true, hydrated: false, transportSet }; }\n" +
      "  const hydrated = !!(data && typeof data.sort === 'function' && ('busy' in data));\n" +  // remote factory has `busy`
      "  const before = nonceOf();\n" +
      "  const btn = root.querySelector('.mui-table__sort'); const hadBtn = !!btn;\n" +
      "  try { await data.sort('deal'); } catch (e) {}\n" +   // drive the remote action directly (deterministic)
      "  const deadline = Date.now() + 3000; let after = before;\n" +
      "  while (Date.now() < deadline) { await new Promise(r => setTimeout(r, 100)); const n = nonceOf(); if (n && n !== before) { after = n; break; } }\n" +
      "  let cloneHydrated = false; try { cloneHydrated = typeof window.Alpine.$data(root.cloneNode(true)).sort === 'function'; } catch (e) { cloneHydrated = false; }\n" +
      "  let errNow = null; try { errNow = window.Alpine.$data(document.querySelector('#component-host [x-data^=\"milpaDataTable\"]')).error; } catch (e) { errNow = 'no-root:'+e.message; }\n" +
      "  return { loaded: true, transportSet, hydrated, before, after, hadBtn, err: errNow, roundTripped: !!(after && after !== before), cloneHydrated };\n" +
      "})()")
    record('components: the Milpa live runtime (Alpine) is loaded in the shell', liveComp.loaded)
    record('components: the bridge transport is wired (window.MilpaLive.transport is a function)', liveComp.transportSet)
    record('components: the hosted component is HYDRATED by the REMOTE factory (has `busy`)', liveComp.hydrated)
    record('components: LOOP CLOSES over the bridge — a sort round-trips and swaps in a fresh state [positive control]', liveComp.roundTripped, 'before=' + JSON.stringify(liveComp.before) + ' after=' + JSON.stringify(liveComp.after) + ' err=' + JSON.stringify(liveComp.err) + ' hadBtn=' + liveComp.hadBtn)
    record('components: an un-hydrated clone stays inert [negative control]', liveComp.cloneHydrated === false)
    await shot('9b-component-remote.png')
  } catch (e) { record('harness ran without throwing', false, String(e)) }

  const failed = checks.filter(c => !c.ok)
  console.log('\n' + (checks.length - failed.length) + '/' + checks.length + ' checks passed · screenshots in test/screenshots/')
  app.exit(failed.length ? 1 : 0)
})
