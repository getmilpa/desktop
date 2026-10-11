// CONTROL for task 3 (t-0092): the boot screen must GUIDE enabling the workspace capability, whose one-time link
// carries agent:run — without it, a person who follows only the panel link cannot write to a session in the panel's
// composer (MILPA_SCOPE_DENIED agent:run; the composer's own message is the house's, tracked apart). This fails on
// main (there is no workspace step) and passes with the fix. The Desktop only guides a SIGNED command; it does not
// widen any grant's scope (decisions/0614 F5).
//
// This checks the TEXT is shown. The PREMISE it teaches — enabling milpa/agent-workspace brings agent:run while the
// panel alone does not — is measured BY EXECUTION in test/scope-premise.sh (recorded in test/scope-premise-measured.txt):
// against the published image, after the panel the first-human scope is `milpa.admin capabilities:enable identity:enroll`
// (no agent:run); after the workspace it is `… agent:read agent:answer agent:run config:write provider:declare identity:enroll`.
'use strict'
const { app, BrowserWindow } = require('electron')
const path = require('path')
const ROOT = path.join(__dirname, '..')
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
app.commandLine.appendSwitch('no-sandbox'); app.commandLine.appendSwitch('disable-gpu'); app.disableHardwareAcceleration()
app.on('window-all-closed', () => {})

const checks = []
function record (name, ok, detail) { checks.push({ ok: !!ok }); console.log((ok ? 'PASS' : 'FAIL') + ' · ' + name + (ok || !detail ? '' : ' — ' + detail)) }

app.whenReady().then(async () => {
  const win = new BrowserWindow({ width: 1100, height: 860, show: true, webPreferences: { preload: path.join(__dirname, 'smoke-boot-preload.js'), contextIsolation: true, sandbox: false } })
  const js = (c) => win.webContents.executeJavaScript(c)
  try {
    await win.loadFile(path.join(ROOT, 'renderer', 'boot.html')); await sleep(400)
    await js("window.milpa.bootSet({ phase: 'up', panel: false, keyPin: true })"); await sleep(1700) // let tick() paint

    // The workspace step exists, is visible, and shows the SIGNED enable of the workspace capability.
    const ws = await js("(()=>{const e=document.querySelector('#cmd-workspace');return e?{present:true,visible:!e.closest('[hidden]')&&!e.hidden,text:e.textContent}:{present:false}})()")
    record('the boot screen GUIDES enabling the workspace (a visible, signed capabilities:enable milpa/agent-workspace)',
      ws.present && ws.visible && /capabilities:enable milpa\/agent-workspace --sign/.test(ws.text || ''), JSON.stringify(ws).slice(0, 160))

    // It names WHY — driving the agent / writing to a session / agent:run — so the person knows to use that link.
    const step = await js("(()=>{const li=[...document.querySelectorAll('#boot-setup li')].find(l=>l.querySelector('#cmd-workspace'));return li?li.textContent:''})()")
    record('the workspace step explains it is what lets you drive the agent (write to a session / agent:run)',
      /workspace/i.test(step) && (/agent/i.test(step) && (/session/i.test(step) || /agent:run/i.test(step))), step.replace(/\s+/g, ' ').slice(0, 160))

    // The workspace step comes AFTER the panel step (the workspace link carries the fuller scope; it is the one to paste).
    const order = await js("(()=>{const ids=[...document.querySelectorAll('#boot-setup li code')].map(c=>c.id);return {panel:ids.indexOf('cmd-panel'),ws:ids.indexOf('cmd-workspace')}})()")
    record('the workspace step is ordered after the panel step', order.ws > order.panel && order.panel >= 0, JSON.stringify(order))
  } catch (e) {
    record('control ran without throwing', false, String(e && e.stack || e))
  }
  const failed = checks.filter((c) => !c.ok).length
  console.log('\n' + (checks.length - failed) + '/' + checks.length + ' boot-workspace checks passed')
  app.exit(failed ? 1 : 0)
})
