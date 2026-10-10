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
})()
