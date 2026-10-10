// Renders the operation the host was asked to sign, and sends back the person's answer (greenhouse decisions/0611).
// It reads ONLY `window.approval` — the narrow bridge sign-approval-preload.js exposes. What it shows is drawn from
// the same authorization the host signs, `canonical` included, so the person sees the exact bytes.
'use strict'
;(function () {
  var a = (window.approval && window.approval.data && window.approval.data()) || {}
  var set = function (id, text) { var el = document.getElementById(id); if (el) el.textContent = text }
  set('op', a.operation || '(no operation named)')
  try { set('args', JSON.stringify(a.arguments || {})) } catch (e) { set('args', '(unreadable)') }
  set('host', a.host || '—')
  set('issuedAt', a.issuedAt || '—')
  set('nonce', a.nonce || '—')
  set('canonical', a.canonical || '')
  document.getElementById('approve').addEventListener('click', function () { window.approval.approve() })
  document.getElementById('deny').addEventListener('click', function () { window.approval.deny() })

  // The deadline the main enforces, shown and counted down — the house's freshness window is 120s, so this is shorter:
  // a person who runs out of time gets a clean refusal here, never a signature the house then rejects as expired.
  var deadline = (window.approval.deadline && window.approval.deadline()) || 0
  if (deadline > 0) {
    var el = document.getElementById('countdown')
    var tick = function () {
      var left = Math.max(0, Math.round((deadline - Date.now()) / 1000))
      if (el) el.textContent = 'expires in ' + left + 's'
      if (left <= 0) { window.approval.deny(); return }
      setTimeout(tick, 250)
    }
    tick()
  }
})()
