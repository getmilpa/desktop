// The boot screen: what the Desktop's window says while the house comes up, before it becomes the house's own panel
// (greenhouse evidence/1091, E3). It reads the state main holds (`milpa.boot()`), never the backend, and the only thing
// it can ask main to do is open a link of THIS house — in the person's browser, or in the window — main checks the
// origin again; this check is only so the person is told at once. Every word goes through the catalog (E6): English
// by default.
;(function () {
  const tr = (k, v) => (window.milpaI18n ? window.milpaI18n.t(k, v) : k)
  const $ = (s) => document.querySelector(s)
  const bridge = window.milpa
  let last = null

  function paint (st) {
    last = st
    const root = $('#boot')
    root.dataset.phase = st.phase
    $('#boot-title').textContent = st.phase === 'failed' ? tr('boot.failed') : st.phase === 'opening' ? tr('boot.opening') : st.phase === 'up' ? tr('boot.up', { origin: st.origin }) : tr('boot.starting')
    $('#boot-error').hidden = st.phase !== 'failed'
    $('#boot-error-text').textContent = st.error || ''
    $('#boot-setup').hidden = !(st.phase === 'up' && !st.panel)
    $('#boot-ready').hidden = !(st.phase === 'up' && st.panel)
    $('#boot-paste').hidden = st.phase !== 'up'
    paintFound()
    $('#cmd-panel').textContent = st.commands.panel
    $('#boot-link').setAttribute('placeholder', tr('boot.paste.placeholder', { origin: st.origin }))
    // WHICH DOOR COMES FIRST (greenhouse decisions/0568). Where the Desktop can ask for a security key's PIN itself
    // (`keyPin`: Linux), the window is the first offer and the browser the other; where it cannot, the browser stays
    // first, as decisions/0566 left it.
    const here = st.keyPin === true
    root.dataset.keyPin = String(here)
    $('#boot-key-note').textContent = tr(here ? 'boot.key.note.here' : 'boot.key.note')
    for (const [browser, win] of [['#boot-open', '#boot-open-here'], ['#boot-panel', '#boot-panel-here']]) {
      $(browser).classList.toggle('mui-btn--primary', !here); $(browser).classList.toggle('mui-btn--secondary', here)
      $(win).classList.toggle('mui-btn--primary', here); $(win).classList.toggle('mui-btn--secondary', !here)
    }
    $('#boot-container').textContent = st.container ? tr('boot.container', { name: st.container, image: st.image, server: st.server }) : ''
  }

  // THE FOUNDING COMMAND, FROM WHAT THE PERSON TYPED (greenhouse decisions/0566). It used to be printed with «…» where
  // the domain and the objective go; Rod copied it as it stood and the house was founded with «…» (evidence/1100).
  // Now there is a command only when both fields say something — a letter or a digit, in any script. The house is
  // the one that judges a declaration (app-runtime refuses a marker); this only keeps the screen from offering one.
  const says = (v) => /[\p{L}\p{N}]/u.test(v)
  // One shell word, whatever was typed: single quotes, and a single quote inside them closed, escaped and reopened.
  const word = (v) => "'" + v.replace(/'/g, "'\\''") + "'"
  function paintFound () {
    if (!last) return
    const code = $('#cmd-found')
    const domain = $('#found-domain').value.trim()
    const objective = $('#found-objective').value.trim()
    const ready = says(domain) && says(objective)
    code.dataset.ready = String(ready)
    code.textContent = ready
      ? `${last.commands.run} foundation:found --domain=${word(domain)} --objective=${word(objective)} --sign`
      : tr('boot.found.incomplete')
  }

  // Where a link of this house opens: 'browser' or 'window'. A security key's PIN is asked in the browser always, and
  // in the window where the Desktop can ask for it (`keyPin`, greenhouse decisions/0568).
  async function open (url, where) {
    const err = $('#boot-link-error')
    let same = false
    try { same = new URL(url).origin === last.origin } catch {}
    if (!same) { err.textContent = tr('boot.paste.foreign', { origin: last.origin }); err.hidden = false; return }
    err.hidden = true
    const r = await (where === 'window' ? bridge.openInWindow(url) : bridge.openInBrowser(url))
    if (!r || !r.ok) { err.textContent = (r && r.error) || tr('boot.paste.foreign', { origin: last.origin }); err.hidden = false }
  }

  $('#found-domain').addEventListener('input', paintFound)
  $('#found-objective').addEventListener('input', paintFound)
  $('#boot-open').addEventListener('click', () => open($('#boot-link').value.trim(), 'browser'))
  $('#boot-open-here').addEventListener('click', () => open($('#boot-link').value.trim(), 'window'))
  $('#boot-link').addEventListener('keydown', (e) => { if (e.key === 'Enter') open($('#boot-link').value.trim(), last && last.keyPin === true ? 'window' : 'browser') })
  $('#boot-panel').addEventListener('click', () => open(last.panelUrl, 'browser'))
  $('#boot-panel-here').addEventListener('click', () => open(last.panelUrl, 'window'))
  window.addEventListener('milpa:locale', () => last && paint(last))

  async function tick () {
    const st = await bridge.boot().catch(() => null)
    if (st) paint(st)
    if (!st || st.phase === 'starting' || st.phase === 'up') setTimeout(tick, 1500)
  }
  tick()
})()
