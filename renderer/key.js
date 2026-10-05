// The PIN window (greenhouse decisions/0568): what the Desktop shows while it runs a passkey ceremony with a security
// key that asks for a PIN. It paints what main says is happening (`milpaKey.onView`) and says two things back: the
// PIN the person typed, or «close». It never tries a PIN again by itself — each one sent is one the person typed and
// submitted — and the field is emptied the moment it is sent.
;(function () {
  const tr = (k, v) => (window.milpaI18n ? window.milpaI18n.t(k, v) : k)
  const $ = (s) => document.querySelector(s)
  const bridge = window.milpaKey
  let last = null

  function paint (view) {
    last = view
    const asking = view.step === 'pin'; const failed = view.step === 'failed'
    $('#key').dataset.step = view.step
    $('#key-title').textContent = tr('key.title.' + view.kind)
    $('#key-who').textContent = tr('key.who.' + view.kind, { origin: view.origin })
    $('#key-step').textContent = view.step === 'choose' ? tr('key.choose', { count: view.count })
      : view.step === 'checking' ? tr('key.checking')
      : view.step === 'touch' ? tr('key.touch')
      : view.step === 'done' ? tr('key.done')
      : asking && view.key ? tr('key.pin.for', { key: view.key }) : ''
    $('#key-form').hidden = !asking
    $('#key-go').hidden = !asking
    if (asking) {
      const left = $('#key-left')
      left.textContent = view.retries === 1 ? tr('key.left.one') : tr('key.left', { n: view.retries })
      left.dataset.low = String(view.retries <= 3)
      $('#key-pin').value = ''
      $('#key-pin').focus()
    }
    // What went wrong: while asking, with the PIN that was typed; when it is over, the reason it is.
    const problem = failed ? tr('key.failed.' + view.problem) : (asking && view.problem ? tr('key.problem.' + view.problem, { min: view.minPinLength || 4 }) : '')
    $('#key-problem').hidden = problem === ''
    $('#key-problem-text').textContent = problem
    $('#key-close').textContent = failed ? tr('key.close') : tr('key.cancel')
  }

  $('#key-form').addEventListener('submit', (e) => {
    e.preventDefault()
    if (!last || last.step !== 'pin') return
    const field = $('#key-pin')
    const pin = field.value
    field.value = ''
    // The window waits for main to say what the key answered; until then there is nothing to submit again.
    $('#key-form').hidden = true; $('#key-go').hidden = true
    bridge.pin(pin)
  })
  $('#key-close').addEventListener('click', () => bridge.close())
  window.addEventListener('keydown', (e) => { if (e.key === 'Escape') bridge.close() })
  window.addEventListener('milpa:locale', () => last && paint(last))
  bridge.onView(paint)
})()
