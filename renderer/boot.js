// The boot screen: what the Desktop's window says while the house comes up, before it becomes the house's own panel
// (greenhouse evidence/1091, E3). It reads the state main holds (`milpa.boot()`), never the backend, and the only thing
// it can ask main to do is open a link of THIS house in the window — main checks the origin again; this check is only
// so the person is told at once. Every word goes through the catalog (E6): English by default.
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
    $('#cmd-found').textContent = st.commands.found
    $('#cmd-panel').textContent = st.commands.panel
    $('#boot-link').setAttribute('placeholder', tr('boot.paste.placeholder', { origin: st.origin }))
    $('#boot-container').textContent = st.container ? tr('boot.container', { name: st.container, image: st.image, server: st.server }) : ''
  }

  async function open (url) {
    const err = $('#boot-link-error')
    let same = false
    try { same = new URL(url).origin === last.origin } catch {}
    if (!same) { err.textContent = tr('boot.paste.foreign', { origin: last.origin }); err.hidden = false; return }
    err.hidden = true
    const r = await bridge.openInWindow(url)
    if (!r || !r.ok) { err.textContent = (r && r.error) || tr('boot.paste.foreign', { origin: last.origin }); err.hidden = false }
  }

  $('#boot-open').addEventListener('click', () => open($('#boot-link').value.trim()))
  $('#boot-link').addEventListener('keydown', (e) => { if (e.key === 'Enter') open($('#boot-link').value.trim()) })
  $('#boot-panel').addEventListener('click', () => open(last.panelUrl))
  window.addEventListener('milpa:locale', () => last && paint(last))

  async function tick () {
    const st = await bridge.boot().catch(() => null)
    if (st) paint(st)
    if (!st || st.phase === 'starting' || st.phase === 'up') setTimeout(tick, 1500)
  }
  tick()
})()
