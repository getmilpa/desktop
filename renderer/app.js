// Milpa Desktop renderer. Talks only through window.milpa (preload bridge). The conversation is driven by
// `coa agent` in the container; while it runs, the UI streams the session's events (tool calls, turns) by
// polling the append-only stream live: the turn runs through `docker exec`, not a request a stream could
// ride (php -S does stream SSE — greenhouse evidence/1035; see main.js at the stream handler).
const $ = (s, r = document) => r.querySelector(s)
const el = (t, p = {}) => Object.assign(document.createElement(t), p)
const bridge = window.milpa
const tr = (k, v) => (window.milpaI18n ? window.milpaI18n.t(k, v) : k)   // i18n — English default, Spanish optional (decisions/0138)

// Authoritative mutation per tool, read ONCE from the op catalogue — each op's DECLARED effect
// (`mutating`), not a guess from its name. A read op like artifact:contract was being mislabelled
// «mutante» by a name regex; the house owns the effect, the card only projects what was declared.
// Null until loaded; toolCard falls back to a conservative heuristic only for a tool not in the catalogue.
let toolMutating = null
async function loadCatalogue () {
  if (!bridge || !bridge.catalogue) return
  const c = await bridge.catalogue().catch(() => null)
  const tools = c && Array.isArray(c.tools) ? c.tools : null
  if (!tools) return
  const map = {}
  for (const t of tools) { if (t && t.name) map[t.name] = t.mutating === true }
  toolMutating = map
}
let current = (() => { try { return localStorage.getItem('milpa.session') || 'default' } catch { return 'default' } })()
// Default autonomy for new drives (Rod, 2026-09-02): `auto` unless the human chose `ask` in Settings.
// The gate still stops for signatures and underdetermined intent server-side; this only sets the default.
function autonomyDefault () { try { const v = localStorage.getItem('milpa.autonomy'); return v === 'ask' ? 'ask' : 'auto' } catch { return 'auto' } }
let sending = false

// ── minimal markdown (headings, bold, code, tables, lists) ──────────────────────────────────────
function md (s) {
  s = String(s ?? ''); const esc = (t) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const inl = (t) => esc(t).replace(/`([^`]+)`/g, '<code>$1</code>').replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>')
  const L = s.split('\n'); const o = []; let i = 0
  while (i < L.length) {
    const l = L[i]
    if (/^\s*\|.*\|/.test(l) && /^\s*\|[\s:|-]+\|/.test(L[i + 1] || '')) {
      const rows = []; while (i < L.length && /^\s*\|/.test(L[i])) rows.push(L[i++])
      const cells = (r) => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim())
      o.push('<table class="mui-table"><thead><tr>' + cells(rows[0]).map(h => `<th>${inl(h)}</th>`).join('') + '</tr></thead><tbody>' +
        rows.slice(2).map(r => '<tr>' + cells(r).map(c => `<td>${inl(c)}</td>`).join('') + '</tr>').join('') + '</tbody></table>'); continue
    }
    if (/^#{1,3}\s/.test(l)) { o.push(`<p style="font-weight:600;margin:.6em 0 .2em">${inl(l.replace(/^#+\s/, ''))}</p>`); i++; continue }
    if (/^\s*[-*]\s/.test(l)) { const it = []; while (i < L.length && /^\s*[-*]\s/.test(L[i])) it.push(`<li>${inl(L[i++].replace(/^\s*[-*]\s/, ''))}</li>`); o.push('<ul style="margin:.3em 0;padding-inline-start:1.2em">' + it.join('') + '</ul>'); continue }
    if (l.trim() === '') { i++; continue }
    o.push(`<p style="margin:.35em 0">${inl(l)}</p>`); i++
  }
  return o.join('')
}
const clean = (h) => h.replace(/^<p[^>]*>|<\/p>$/g, '')

function isClosure (value) { return value && typeof value === 'object' && typeof value.verified === 'boolean' }
function renderAgentAnswer (answer, closure) {
  const raw = cleanQuestion(String(answer ?? '')).trim()
  const answerHtml = md(raw || tr('agent.noAnswer'))
  if (!isClosure(closure)) return answerHtml

  const verified = closure.verified
  const reasons = Array.isArray(closure.reasons) ? closure.reasons.map(x => String(x).trim()).filter(Boolean) : []
  const reasonHtml = !verified && reasons.length
    ? `<p class="mui-alert__desc">${tr('closure.reasons')}</p>${md(reasons.map(x => `- ${x}`).join('\n'))}`
    : ''
  const trivial = Array.from(raw).length <= 3
  return `<div class="mui-alert ${verified ? 'mui-alert--success' : 'mui-alert--warning'} closure-verdict" role="status">
    <span class="mui-alert__icon">${verified ? '✓' : '!'}</span><div class="mui-alert__content"><p class="mui-alert__title">${tr(verified ? 'closure.verified' : 'closure.unverified')}</p>${reasonHtml}</div></div>
    <div class="closure-answer${trivial ? ' dv-note' : ''}" style="margin-top:var(--space-2)${trivial ? ';opacity:.6' : ''}">${answerHtml}</div>`
}

// ── conversation ────────────────────────────────────────────────────────────────────────────────
function clearEmpty () { const e = $('#conv .mui-empty'); if (e) $('#conv').innerHTML = '' }
function scroll () { const c = $('#conv'); c.scrollTop = c.scrollHeight }
function addUser (text, at) {
  clearEmpty(); const t = (at ? new Date(at) : new Date()).toLocaleTimeString('es', { hour: '2-digit', minute: '2-digit' })
  const w = el('div', { className: 'msg-user' }); const b = el('div')
  b.innerHTML = `<span class="dv-note">persona · ${t}</span><p style="margin:var(--space-1) 0 0;font-size:var(--text-sm)">${clean(md(text))}</p>`
  w.append(b); $('#conv').append(w); scroll()
}
function toolCard (p) {
  const ok = p.ok !== false
  // Authoritative: the op's DECLARED `mutating`, read from the catalogue by tool name. Only when a
  // tool is absent from the catalogue do we fall back to a name heuristic — and even then not on
  // `awaitingConfirmation` (which is present-and-false for non-confirming mutations, and was flipping
  // read ops to «mutante»), nor on «found» (which matched read ops like foundation:found).
  const declared = toolMutating && p.tool != null ? toolMutating[p.tool] : undefined
  const mut = declared !== undefined ? declared : /write|make|set|enable|disable|register/.test(p.tool || '')
  const d = el('details', { className: 'mui-card mui-card--compact' }); d.style.margin = 'var(--space-3) 0'
  // fmtArgVal (not String(v)): an array/object arg like `edits:[{find,replace}]` becomes readable
  // JSON instead of «[object Object]». The summary line clips with ellipsis, so length is bounded.
  const args = p.arguments && Object.keys(p.arguments).length ? Object.entries(p.arguments).map(([k, v]) => `${k}=${fmtArgVal(v)}`).join(' ') : ''
  const res = fmtResult(p.result).slice(0, 800)
  d.innerHTML = `<summary style="display:flex;align-items:center;gap:var(--space-3);padding:var(--space-3);cursor:pointer;font-family:var(--font-mono);font-size:var(--text-xs)">
    <span class="mui-badge ${ok ? 'mui-badge--success' : 'mui-badge--danger'}" style="flex:none">${ok ? 'ok' : 'err'}</span><span style="flex:none;font-weight:600;color:var(--text)">${p.tool || 'tool'}</span>
    <span style="flex:1 1 auto;color:var(--text-secondary);min-width:0;white-space:nowrap;overflow:hidden;text-overflow:ellipsis">${args}</span>
    <span class="mui-badge ${mut ? 'mui-badge--warning' : ''}" style="flex:none">${mut ? 'mutante' : 'llamada, no efecto'}</span></summary>
    ${res ? `<div class="mui-terminal" style="margin:0 var(--space-3) var(--space-3)"><div class="mui-terminal__bar"><span class="dv-note">salida de la herramienta${p.resultChars ? ' · ' + p.resultChars + ' chars' : ''}</span></div><div class="mui-terminal__body"><p class="mui-terminal__line"><span class="mui-terminal__out" style="white-space:pre-wrap;overflow-wrap:anywhere">${clean(res)}</span></p></div></div>` : ''}`
  return d
}
function addAgentBubble () {
  clearEmpty(); const w = el('div', { className: 'msg-agent', id: 'live-agent' })
  w.innerHTML = `<details id="live-trace" class="mui-trace" open><summary class="dv-note" id="live-meta">${tr('agent.working')}</summary><div id="live-reasoning" class="mui-reasoning"></div><div id="live-tools" style="margin-top:var(--space-2)"></div></details><div id="live-answer" style="margin:var(--space-2) 0 0;font-size:var(--text-sm);line-height:var(--leading-relaxed)"></div>`
  $('#conv').append(w); scroll(); return w
}

// ── argument + question formatting (cabo: no raw JSON in the gate) ───────────────────────────────
function fmtArgVal (v) {
  if (v == null) return ''
  if (typeof v === 'object') { try { const j = JSON.stringify(v); return j.length > 80 ? j.slice(0, 79) + '…' : j } catch { return String(v) } }
  const x = String(v); return x.length > 80 ? x.slice(0, 79) + '…' : x
}
function fmtArgs (a) { return Object.entries(a || {}).map(([k, v]) => `${k}=${fmtArgVal(v)}`).join(' ') }
// A tool result is usually a JSON envelope ({ok, error|result|message}). Show the human part with real
// newlines (JSON.parse turns \n escapes into breaks); fall back to the raw text when it isn't JSON.
function fmtResult (raw) {
  const s = String(raw ?? '')
  try { const j = JSON.parse(s); if (j && typeof j === 'object') return String(j.error ?? j.result ?? j.message ?? JSON.stringify(j, null, 2)) } catch {}
  return s.replace(/\\n/g, '\n')
}
// The backend sometimes appends the raw argument JSON to the question ("… con: {…}"). The arguments are
// rendered structured in the facts line below, so strip the raw blob rather than dump it into the prose.
function cleanQuestion (t) { if (!t) return t; const x = String(t).replace(/\n*\s*con:\s*\{[\s\S]*\}\s*$/i, '').trim(); return x || String(t) }

// ── the decision gate (from agent:show.question) ────────────────────────────────────────────────
function renderGate (q) {
  if ($('#gate-card')) return
  let op = q.operation || q.tool || '—', args = '', parsedArgs = {}
  try { const w = typeof q.why === 'string' ? JSON.parse(q.why) : (q.why || {}); if (w.operation) op = w.operation; if (w.arguments) { parsedArgs = w.arguments; args = fmtArgs(w.arguments) } } catch {}
  const opts = Array.isArray(q.options) ? q.options : ['sí', 'no']
  const yesD = opts.includes('sí') ? 'sí' : opts[0]
  const denyD = opts.includes('no') ? 'no' : opts[opts.length - 1]
  // A capabilities:enable is a SIGNABLE act, not a session permission — the doctrine keeps the two
  // distinct (a signature names THIS call and is made with a key that lives outside the session, so no
  // mode pre-approves it). So the gate must not offer a dead "authorize": it routes to the out-of-band
  // signed enable (creating a key first if there is none), then answers the gate so the turn resumes.
  const isEnable = op === 'capabilities:enable'
  const cap = isEnable ? String(parsedArgs.capability || '').trim() : ''
  const c = el('div', { className: 'mui-card mui-card--raised', id: 'gate-card' }); c.style.cssText = 'border-color:var(--warning-border);background:var(--warning-bg);margin-top:var(--space-3)'
  const decisions = (isEnable && cap)
    ? `<button type="button" class="mui-btn mui-btn--primary mui-btn--sm" id="gate-sign">${tr('gate.signEnable', { cap })}</button>
       <button type="button" class="mui-btn mui-btn--danger mui-btn--sm" data-d="${denyD}">${tr('gate.deny')}</button>`
    : `<button type="button" class="mui-btn mui-btn--primary mui-btn--sm" data-d="${yesD}">${tr('gate.authorize')}</button>
       <button type="button" class="mui-btn mui-btn--sm">${tr('gate.adjust')}</button>
       <button type="button" class="mui-btn mui-btn--danger mui-btn--sm" data-d="${denyD}">${tr('gate.deny')}</button>`
  c.innerHTML = `<div class="mui-card__body mui-gate">
    <div class="mui-gate__request"><p class="mui-gate__actor" style="margin:0">${tr('gate.stopped')}</p>
    <p class="mui-gate__action" style="margin:var(--space-1) 0">${clean(md(cleanQuestion(q.question) || tr('gate.authRequired')))}</p>
    <p class="mui-gate__facts" style="margin:0">${tr('gate.operation')} <strong>${op}</strong>${args ? ' · ' + args : ''} · ${tr('gate.reason')}: <strong>${q.reason || '—'}</strong> · ${tr('gate.authority')} · ${tr('gate.signature')}: <strong>${tr('gate.notPresented')}</strong></p></div>
    <div class="mui-gate__decisions">${decisions}</div>
    <p class="dv-note" id="gate-status" style="margin:var(--space-1) 0 0" aria-live="polite"></p>
    ${isEnable ? '' : `<div class="mui-gate__passkey" style="margin:var(--space-2) 0 0;display:flex;gap:var(--space-2);align-items:center;flex-wrap:wrap">
      <button type="button" class="mui-btn mui-btn--sm" id="gate-passkey">${tr('gate.approvePasskey')}</button>
      <button type="button" class="mui-btn mui-btn--ghost mui-btn--sm" id="gate-passkey-enroll">${tr('gate.registerPasskey')}</button></div>`}
    <p class="dv-note" style="margin:var(--space-1) 0 0">${isEnable && cap ? tr('gate.signHint') : tr('gate.note')}</p></div>`
  c.querySelectorAll('[data-d]').forEach(b => b.addEventListener('click', async () => {
    c.querySelectorAll('button').forEach(x => x.disabled = true)
    await bridge.answer(current, b.dataset.d)
    c.querySelector('.mui-gate__decisions').innerHTML = `<span class="mui-badge mui-badge--success">${tr('gate.answered', { answer: b.dataset.d })}</span>`
    // Authorizing IS the intent to continue — the system resolves the «Continue» verb for you (Rod's
    // principle: never re-specify what the system can infer). A deny or a scope-adjust does not resume.
    if (b.dataset.d === yesD) { await refreshShow(); send('continúa') } else { refreshShow() }
  }))
  // Passkey ceremony: opens its own http://localhost window (WebAuthn cannot run in this file:// renderer)
  // showing THIS operation, so the human authorizes the exact call with a touch (greenhouse decisions/0187).
  const pkBtn = c.querySelector('#gate-passkey')
  if (pkBtn) pkBtn.addEventListener('click', async () => {
    const status = c.querySelector('#gate-status')
    const r = await (bridge.passkey ? bridge.passkey.approve(current, op, parsedArgs) : Promise.resolve({ opened: false, error: 'no bridge' })).catch(e => ({ opened: false, error: String(e) }))
    if (status) status.textContent = (r && r.opened) ? tr('gate.passkeyOpened') : tr('gate.passkeyFailed', { error: (r && r.error) || '—' })
  })
  const pkEnroll = c.querySelector('#gate-passkey-enroll')
  if (pkEnroll) pkEnroll.addEventListener('click', async () => {
    const status = c.querySelector('#gate-status')
    const r = await (bridge.passkey ? bridge.passkey.enroll() : Promise.resolve({ opened: false, error: 'no bridge' })).catch(e => ({ opened: false, error: String(e) }))
    if (status) status.textContent = (r && r.opened) ? tr('gate.enrollOpened') : tr('gate.passkeyFailed', { error: (r && r.error) || '—' })
  })
  const signBtn = c.querySelector('#gate-sign')
  if (signBtn) signBtn.addEventListener('click', async () => {
    const status = c.querySelector('#gate-status')
    const say = (m) => { if (status) status.textContent = m }
    const reenable = () => c.querySelectorAll('button').forEach(x => { x.disabled = false })
    c.querySelectorAll('button').forEach(x => x.disabled = true)
    // 1 · ensure a signing key — the software path mints one on the spot (a YubiKey/card already IS the key)
    let k = await bridge.keys().catch(() => null)
    if (!k || k.custody === 'none') {
      say(tr('gate.creatingKey'))
      const kg = await bridge.keygen().catch(e => ({ ok: false, error: String(e) }))
      if (!kg || kg.ok === false) { say(tr('gate.enableFailed', { error: (kg && kg.error) || 'keygen' })); reenable(); return }
    }
    // 2 · the signed, out-of-band enable — `capabilities:enable --sign`, which names the call and signs it
    say(tr('gate.signing'))
    const r = await bridge.enableCapability(cap).catch(e => ({ ok: false, error: String(e) }))
    if (!r || r.ok === false) { say(tr('gate.enableFailed', { error: (r && (r.error || r.raw)) || '—' })); reenable(); return }
    const list = Array.isArray(r.unlocked) ? r.unlocked.join(', ') : (r.unlocked || r.unlocks || '')
    const done = tr('gate.enabled', { cap }) + (list ? tr('gate.unlocks', { list }) : '')
    // 3 · resume — the capability is installed; answering the pending question lets the agent continue with it
    await bridge.answer(current, yesD)
    c.querySelector('.mui-gate__decisions').innerHTML = `<span class="mui-badge mui-badge--success">${done}</span>`
    refreshShow()
  })
  $('#conv').append(c); scroll()
}

// ── drive + LIVE streaming (poll events while the agent runs) ────────────────────────────────────
// Each model call that reasons emits one `session.model_reasoned` with its full reasoning_content —
// appended live into the collapsible trace, which folds it away when the turn resolves (cabo: stream then collapse).
function appendReasoning (text) {
  const t = (text || '').toString().trim(); if (!t) return
  const host = $('#live-reasoning'); if (!host) return
  if (!host.dataset.kicked) { host.dataset.kicked = '1'; host.append(html(`<p class="mui-section__kicker" style="margin:0 0 var(--space-1)">${tr('agent.reasoning')}</p>`)) }
  host.append(html(`<p class="dv-note" style="white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.5;margin:0 0 var(--space-2)">${clean(t)}</p>`))
  const m = $('#live-meta'); if (m) m.textContent = tr('agent.reasoningLive')
  scroll()
}
function startBusy () { sending = true; const b = $('#send'); if (b) { b.disabled = false; b.dataset.stop = '1'; b.textContent = tr('send.stop') } }
function endBusy () { sending = false; const b = $('#send'); if (b) { b.disabled = false; delete b.dataset.stop; b.textContent = tr('send.button') } }
async function stopAgent () {
  if (!sending) return
  await (bridge.stopAgent ? bridge.stopAgent() : Promise.resolve()).catch(() => {})
  endBusy(); setLive('idle', tr('live.live')); refreshShow()
}
async function send (forced) {
  const ta = $('#query'); const q = (forced != null ? forced : ta.value).trim(); if (!q || sending || !bridge) return
  startBusy(); if (forced == null) ta.value = ''
  addUser(q); const bubble = addAgentBubble()
  setLive('working', tr('live.working'))
  const before = (await bridge.events(current, 0)).total
  let seen = before
  let parked = false
  // Drop the streaming ids and reclass the live meta line — the bubble is no longer «live».
  const finalize = () => {
    bubble.removeAttribute('id')
    const meta = bubble.querySelector('#live-meta'); if (meta) { meta.className = 'dv-note'; meta.id = '' }
    const lt = bubble.querySelector('#live-tools'); if (lt) lt.id = ''
    const ans = bubble.querySelector('#live-answer'); if (ans) ans.id = ''
    const lr = bubble.querySelector('#live-reasoning'); if (lr) lr.id = ''
    const trace = bubble.querySelector('#live-trace'); if (trace) { trace.open = false; trace.id = '' }
    return { meta, ans }
  }
  // A turn ends two ways: it RETURNS (drive resolves with an answer) or it PARKS on a durable gate — the agent
  // asks a question and stops, and `drive` may never resolve. The gate lives in Decisiones, but Conversación
  // must not stay frozen on «pensando»: the moment a question is asked, leave the thinking state and point here
  // to Decisiones (greenhouse decisions/0132). This is driven by the event stream, NOT by drive resolving.
  const onParked = async () => {
    if (parked) return; parked = true
    clearInterval(poll)
    const { meta, ans } = finalize()
    if (meta) meta.textContent = tr('agent.parked')
    if (ans) ans.innerHTML = md(tr('conv.parkedNote'))
    setLive('wait', tr('live.waiting'))
    await refreshShow()   // renders the gate (renderGate), the session badge and the Decisiones badge
    scroll(); endBusy()
  }
  const poll = setInterval(async () => {
    const { events } = await bridge.events(current, seen); if (!events.length) return
    for (const e of events) {
      if (e.type === 'session.tool_called') $('#live-tools')?.append(toolCard(e.payload))
      else if (e.type === 'session.model_called') { const m = $('#live-meta'); if (m) m.textContent = tr('agent.thinking', { model: e.payload.model || '' }) }
      else if (e.type === 'session.model_reasoned') appendReasoning(e.payload && e.payload.reasoning)
      else if (e.type === 'session.debt_signaled') refreshDebt()
      else if (e.type === 'session.question_asked') { await onParked(); return }
    }
    seen += events.length; scroll()
  }, 1200)
  const res = await bridge.drive(q, current, autonomyDefault())
  if (parked) return   // the poll already surfaced the parked-on-question state; don't clobber it
  clearInterval(poll)
  const { meta, ans } = finalize()
  if (res && res.ok !== false) {
    await refreshShow()
    // A turn can also return WITH a pending question (drive resolved but the agent parked) — honor that too.
    if (res.question || (res.answer == null && res.ok !== false && !res.steps && !res.tools)) {
      if (meta) meta.textContent = 'agente · pregunta pendiente · responde en Decisiones'
      if (ans) ans.innerHTML = md(tr('conv.parkedNote'))
    } else {
      if (meta) meta.textContent = tr('agent.steps', { steps: res.steps || '', tools: res.tools || '' })
      const closure = isClosure(res.closure) ? res.closure : (lastShow && lastShow.closure)
      if (ans) ans.innerHTML = renderAgentAnswer(res.answer, closure)
    }
    if (!(lastShow && lastShow.question)) setLive('idle', tr('live.live'))   // the turn is done — don't leave «Trabajando…» stuck
  } else { if (ans) ans.innerHTML = md(tr('conv.driveError') + (res?.error || tr('conv.driveErrorHint'))); setLive('err', tr('live.error')) }
  scroll(); endBusy()
}

// ── repaint the conversation from the stream, so a reload never loses the transcript (no huecos) ──
// Reconstructs turns from the session events with the SAME clean helpers the live path uses: user/assistant
// turns from `session.turn`, the agent's reasoning and tool calls grouped into a collapsed trace, and the
// answer cleaned of any raw `con:` argument blob. Runs once on open, before any live turn appends.
async function paintHistory () {
  const conv = $('#conv'); if (!conv || !bridge) return
  let events = []
  try { events = (await bridge.events(current, 0)).events || [] } catch { return }
  if (!events.length) return
  conv.innerHTML = ''                                   // drop the empty state; we have a transcript
  let bubble = null
  const ensureAgent = () => {
    if (bubble) return
    bubble = el('div', { className: 'msg-agent' })
    bubble.innerHTML = `<details class="mui-trace"><summary class="dv-note">${tr('agent.working')}</summary><div class="h-reason mui-reasoning"></div><div class="h-tools" style="margin-top:var(--space-2)"></div></details><div class="h-answer" style="margin:var(--space-2) 0 0;font-size:var(--text-sm);line-height:var(--leading-relaxed)"></div>`
    conv.append(bubble)
  }
  const close = (metaText, answerHtml) => {
    if (!bubble) return
    const sm = bubble.querySelector('summary'); if (sm && metaText) sm.textContent = metaText
    const rz = bubble.querySelector('.h-reason'); if (rz && !rz.children.length) rz.remove()
    const tl = bubble.querySelector('.h-tools'); if (tl && !tl.children.length) tl.remove()
    const an = bubble.querySelector('.h-answer'); if (an && answerHtml != null) an.innerHTML = answerHtml
    bubble = null
  }
  let steps = 0, toolN = 0, lastAnswer = null
  for (const e of events) {
    const p = e.payload || {}
    if (e.type === 'session.turn' && p.role === 'user') {
      close(tr('agent.steps', { steps: steps || 1, tools: toolN }), null); steps = 0; toolN = 0
      lastAnswer = null
      addUser(String(p.content || ''), e.recorded_at)
    } else if (e.type === 'session.turn' && p.role === 'assistant') {
      ensureAgent()
      lastAnswer = { bubble, answer: String(p.content || '') }
      close(tr('agent.steps', { steps: steps || 1, tools: toolN }), renderAgentAnswer(lastAnswer.answer)); steps = 0; toolN = 0
    } else if (e.type === 'session.closure_derived' && lastAnswer && isClosure(p)) {
      const answer = lastAnswer.bubble.querySelector('.h-answer')
      if (answer) answer.innerHTML = renderAgentAnswer(lastAnswer.answer, p)
    } else if (e.type === 'session.model_reasoned') {
      ensureAgent()
      const host = bubble.querySelector('.h-reason'); const t = String(p.reasoning || '').trim()
      if (host && t) {
        if (!host.dataset.kicked) { host.dataset.kicked = '1'; host.append(html(`<p class="mui-section__kicker" style="margin:0 0 var(--space-1)">${tr('agent.reasoning')}</p>`)) }
        host.append(html(`<p class="dv-note" style="white-space:pre-wrap;overflow-wrap:anywhere;line-height:1.5;margin:0 0 var(--space-2)">${clean(t)}</p>`))
      }
    } else if (e.type === 'session.tool_called') {
      ensureAgent(); bubble.querySelector('.h-tools').append(toolCard(p)); toolN++
    } else if (e.type === 'session.model_called') {
      steps++
    } else if (e.type === 'session.question_asked') {
      ensureAgent(); close(tr('agent.parked'), md(tr('conv.parkedNote')))
    }
  }
  close(tr('agent.steps', { steps: steps || 1, tools: toolN }), null)   // finalize any turn left open
  scroll()
}

// ── agent:show → inspector, Work, Context, gate, status counts ──────────────────────────────────
let lastShow = null
let ownerVerified = false      // last verified-owner projection; gates the identity nudge
let interruptShown = false
let lastCompacted = -1         // last compactedThrough seen — a rise means the house just compacted
let compactingUntil = 0        // while set in the future, the live indicator holds "Compacting…"
async function refreshShow () {
  if (!bridge) return
  const show = await bridge.show(current); lastShow = show
  if (!show || show.ok === false) return
  if (show.goal) { const g = $('#goal'); g.textContent = show.goal; g.title = show.goal; $('#goal-sub').textContent = tr('inspector.sessionMode', { session: current, mode: show.mode || autonomyDefault() }) }
  renderInspector(show); renderWork(show); renderContext(show); renderDecisiones(show)
  checkInterrupted(show)
  const pend = !!show.question
  $('#session-badge').hidden = !pend
  if (pend) { $('#session-badge').textContent = tr('session.badge.waiting'); $('#session-badge').className = 'mui-badge mui-badge--warning mui-badge--dot'; renderGate(show.question); setLive('wait', tr('live.waiting')) }
  else if (!sending) setLive('idle', tr('live.live'))
  const nd = document.querySelectorAll('.mui-sidebar__item[data-nav="decisiones"] .mui-sidebar__item-badge')[0]
  if (nd) { nd.hidden = !pend; nd.textContent = '1' }
  const t = show.turns ?? '', cc = (show.callCount ?? show.toolCalls ?? '')
  $('#st-counts').textContent = `${t ? t + ' turnos' : ''}${show.compactedThrough ? ' · compactado ' + show.compactedThrough : ''}`
  // The house compacts the window (locally, from the session facts) — tell the human when it does,
  // so a shrinking window is a visible act, not a silent one. A rise in compactedThrough since the
  // last poll is a fresh compaction.
  const ct = show.compactedThrough || 0
  if (lastCompacted >= 0 && ct > lastCompacted) flashCompacting()
  lastCompacted = ct
  refreshOwner()
  refreshTokens()
  refreshDebt()
}

// ── interrupted run (greenhouse decisions/0132) ─────────────────────────────────────────────────
// A killed window kills the `docker exec` that drove `coa agent`, cutting the run mid-flight: tasks stay
// in-progress with no agent process, and nothing in the UI says so. On load we DETECT that (work in progress +
// no live driver) and REPORT it — we never auto-resume, because replaying a killed run could repeat
// side-effectful tool calls; «Continuar» stays the user's deliberate verb.
async function checkInterrupted (show) {
  if (interruptShown || sending || !bridge || !bridge.agentRunning) return
  if (show.question) return                          // a parked question is the gate path, not an interruption
  const steps = [...(Array.isArray(show.plan) ? show.plan : []), ...(show.todos || [])]
  const inProgress = steps.some(x => /progress|active|doing|current|in_progress/.test(String((x && (x.status || x.state)) || '')))
  if (!inProgress) return
  const r = await bridge.agentRunning().catch(() => null)
  if (!r || r.running !== false) return               // fail-closed: only claim interruption when NO agent runs
  interruptShown = true; clearEmpty()
  const c = el('div', { className: 'mui-card mui-card--raised', id: 'interrupted-card' })
  c.style.cssText = 'border-color:var(--danger-border);background:var(--danger-bg);margin-top:var(--space-3)'
  c.innerHTML = `<div class="mui-card__body"><p class="mui-section__kicker" style="margin:0 0 var(--space-1)">${tr('interrupted.kicker')}</p>
    <p style="margin:0;font-size:var(--text-sm)">${tr('interrupted.body')}</p></div>`
  const conv = $('#conv'); if (conv) conv.prepend(c)
  setLive('err', tr('live.interrupted'))
}

// ── identity projection ─────────────────────────────────────────────────────────────────────────
// PROJECTS what the house recognizes (coa session:owner), re-verified live. The UI never decides
// identity — it shows the fact the house produced, or «usuario del sistema» when there is none
// (greenhouse decisions/0120).
async function refreshOwner () {
  if (!bridge || !bridge.owner) return
  const el = $('#st-identity'); if (!el) return
  try {
    const o = await bridge.owner(current)
    ownerVerified = !!(o && o.ok && o.verified && o.owner)
    if (o && o.ok && o.verified && o.owner) {
      const fp = String(o.owner).replace(/^key:/, '')
      const short = fp.length > 12 ? fp.slice(0, 4) + '…' + fp.slice(-4) : fp
      const scopes = Array.isArray(o.scopes) ? o.scopes.length : 0
      el.textContent = `🔑 key:${short} · verificado${scopes ? ' · ' + scopes + ' permiso' + (scopes === 1 ? '' : 's') : ''}`
      el.title = `principal verificado ${o.owner}` + (scopes ? ' — ' + o.scopes.join(', ') : '')
      el.style.color = 'var(--olivo, #7a8b5a)'
    } else {
      el.textContent = '◍ usuario del sistema'
      el.title = (o && o.note) ? o.note : tr('owner.noOwnerTitle')
      el.style.color = ''
    }
  } catch { /* leave the last projection; a read failure is not an identity claim */ }
}

// ── inspector drawer ────────────────────────────────────────────────────────────────────────────
function renderInspector (show) {
  const box = $('#inspector-body'); if (!box) return; box.innerHTML = ''
  if (show.question) box.append(html(`<div class="mui-card mui-card--compact" style="border-color:var(--warning-border)"><div class="mui-card__body"><p class="mui-section__kicker" style="margin:0 0 var(--space-1)">bloqueo accionable</p><p style="margin:0;font-size:var(--text-sm)">1 pregunta pendiente detiene el trabajo.</p></div></div>`))
  // plan may be a numbered string or an array of steps; todos carry the real per-step status
  let steps = []
  if (Array.isArray(show.plan)) steps = show.plan.map(x => ({ title: x.title || x.text || x, status: x.status || x.state }))
  else if (typeof show.plan === 'string') steps = show.plan.split(/\n/).map(l => l.replace(/^\s*\d+[.)]\s*/, '').trim()).filter(l => l && !/^auditor|^plan/i.test(l)).map(t => ({ title: t }))
  const todos = show.todos || []
  if (todos.length && steps.length) steps = steps.map((st, i) => ({ ...st, status: st.status || todos[i]?.status }))
  if (!steps.length && todos.length) steps = todos.map(t => ({ title: t.text || t.title, status: t.status }))
  if (steps.length) box.append(html(`<div><p class="mui-section__kicker" style="margin:0 0 var(--space-2)">${tr('inspector.plan')}</p><ol class="mui-steps">${steps.map(s => { const st = (s.status || '').toString(); const cl = st.match(/done|complete/) ? 'complete' : st.match(/active|progress|current|doing/) ? 'active' : ''; return `<li class="mui-steps__item" data-status="${cl}"><span class="mui-steps__marker"></span><span class="mui-steps__title">${s.title.toString().slice(0, 60)}</span></li>` }).join('')}</ol></div>`))
  const perms = show.permissions || []
  if (perms.length) box.append(html(`<div><p class="mui-section__kicker" style="margin:0 0 var(--space-2)">${tr('inspector.permissions')}</p><div class="mui-stack mui-stack--sm">${perms.slice(0, 6).map(p => { const g = (p.status || p.grant || '').toString(); const b = g.match(/grant|otorg/) ? 'mui-badge--success' : g.match(/sign|firma/) ? 'mui-badge--warning' : g.match(/retir|revok/) ? 'mui-badge--danger' : ''; return `<div class="mui-cluster mui-cluster--sm" style="justify-content:space-between"><span class="dv-note">${p.operation || p.name || p.tool || p}</span>${g ? `<span class="mui-badge ${b}">${g}</span>` : `<button type="button" class="mui-btn mui-btn--sm perm-view">${tr('perm.view')}</button>`}</div>` }).join('')}</div></div>`))
  if (!box.children.length) box.append(html(`<p class="dv-note">${tr('inspector.noPlan')}</p>`))
}
function html (s) { const t = el('template'); t.innerHTML = s.trim(); return t.content.firstElementChild }

// ── Work panel (todos → board columns) ──────────────────────────────────────────────────────────
function renderWork (show) {
  const p = $('[data-panel="trabajo"]'); if (!p) return
  const todos = show.todos || []
  const cols = { Pendiente: [], 'En curso': [], Terminada: [], Bloqueada: [] }
  for (const t of todos) { const s = (t.status || t.state || 'pending').toString()
    const k = s.match(/block|held|wait/) ? 'Bloqueada' : s.match(/done|complete/) ? 'Terminada' : s.match(/progress|active|doing/) ? 'En curso' : 'Pendiente'; cols[k].push(t) }
  p.innerHTML = `<div class="mui-card mui-card--compact" style="margin-bottom:var(--space-4)"><div class="mui-card__body"><p class="mui-section__kicker" style="margin:0 0 var(--space-1)">${tr('work.plan')}${show.planVersion ? ' · v' + show.planVersion : ''} · ${tr('work.writtenBy')}</p><p style="margin:0;font-size:var(--text-sm);color:var(--text-secondary)">${show.goal || tr('work.noGoal')}</p></div></div>
    <div style="display:grid;grid-template-columns:repeat(4,1fr);gap:var(--space-4);align-items:start">
    ${Object.entries(cols).map(([name, items]) => `<section style="display:flex;flex-direction:column;gap:var(--space-3)"><div class="mui-cluster mui-cluster--sm" style="justify-content:space-between"><span class="mui-section__kicker" style="margin:0">${name}</span><span class="mui-badge ${name === 'Bloqueada' && items.length ? 'mui-badge--warning' : ''}">${items.length}</span></div>${items.map(t => `<article class="mui-card mui-card--compact" ${name === 'Bloqueada' ? 'style="border-color:var(--warning-border);background:var(--warning-bg)"' : ''}><div class="mui-card__body"><p style="margin:0;font-size:var(--text-sm)">${(t.title || t.text || t).toString().slice(0, 80)}</p>${t.origin ? `<span class="mui-badge" style="margin-top:var(--space-2)">${t.origin}</span>` : ''}</div></article>`).join('') || '<div class="mui-empty" style="border:1px dashed var(--border);border-radius:var(--radius-md);padding:var(--space-4)"><p class="dv-note">—</p></div>'}</section>`).join('')}</div>
    <div class="mui-alert mui-alert--info" role="note" style="margin-top:var(--space-4)"><span class="mui-alert__icon">i</span><div class="mui-alert__content"><p class="mui-alert__desc">Mover una tarjeta nunca concede permiso. Al terminar, el trabajo abierto se dispone a mano.</p></div></div>`
}

// ── Context panel (call vs effect projection) ───────────────────────────────────────────────────
function ctxWindow () { try { return parseInt(localStorage.getItem('milpa.ctxWindow') || '', 10) || 0 } catch { return 0 } }

function renderContext (show) {
  const p = $('[data-panel="contexto"]'); if (!p) return
  const win = ctxWindow()
  p.innerHTML = `<div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-5);align-items:start">
    <div class="mui-card"><div class="mui-card__header"><h2 class="mui-card__title">Ventana de contexto</h2></div><div class="mui-card__body mui-stack mui-stack--sm">
      <div id="ctx-fill"></div>
      <div id="ctx-tokens" class="mui-replay__projection"><p class="dv-note">Leyendo el stream…</p></div>
      <label class="mui-cluster mui-cluster--sm" style="justify-content:space-between;margin-top:var(--space-2)">
        <span class="dv-note">${tr('context.windowSize')}</span>
        <input id="ctx-window" class="mui-input" style="width:9rem;font-family:var(--font-mono);font-size:var(--text-xs)" inputmode="numeric" placeholder="p.ej. 32768" value="${win || ''}">
      </label></div></div>
    <div class="mui-card"><div class="mui-card__header"><h2 class="mui-card__title">Llamada vs. efecto</h2></div><div class="mui-card__body"><div class="mui-replay__projection">
      <p class="mui-replay__stat"><span class="mui-replay__stat-label">turnos</span><span class="mui-replay__stat-value">${show.turns ?? '—'}</span></p>
      <p class="mui-replay__stat"><span class="mui-replay__stat-label">compactado hasta</span><span class="mui-replay__stat-value">${show.compactedThrough ?? 'no'}</span></p>
      <p class="mui-replay__stat"><span class="mui-replay__stat-label">decisiones</span><span class="mui-replay__stat-value">${(show.decisions || []).length}</span></p>
      <p class="mui-replay__stat"><span class="mui-replay__stat-label">verificados</span><span class="mui-replay__stat-value" style="color:var(--text-muted)">no observable</span></p></div>
      <p class="dv-note" style="line-height:1.6;margin-top:var(--space-3)">${tr('context.note')}</p></div></div></div>`
  const wi = $('#ctx-window')
  if (wi) wi.addEventListener('change', () => { try { localStorage.setItem('milpa.ctxWindow', String(parseInt(wi.value, 10) || '')) } catch {} ; refreshTokens() })
  refreshTokens()
}

// ── honest token / context telemetry (H-USAGE-1: reads the model_returned facts of the stream) ────
async function refreshTokens () {
  if (!bridge || !current) return
  let spent = 0, lastPrompt = 0, lastTotal = 0, cached = 0, calls = 0
  try {
    const { events } = await bridge.events(current, 0)
    for (const e of events) {
      if (e.type !== 'session.model_returned') continue
      const u = (e.payload && e.payload.usage) || {}
      calls++
      spent += (u.total_tokens || 0)
      lastPrompt = u.prompt_tokens || 0
      lastTotal = u.total_tokens || 0
      cached += (u.cached_tokens || 0)
    }
  } catch { return }
  const fmt = n => n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n)

  // status-bar chip
  const chip = $('#st-tokens')
  if (chip) chip.textContent = calls ? `▦ ${fmt(lastPrompt)} en ventana · ${fmt(spent)} gastados · ${calls} llamada${calls === 1 ? '' : 's'}` : ''

  // context panel stats + fill bar (only when the panel is mounted)
  const stats = $('#ctx-tokens')
  if (stats) {
    stats.innerHTML =
      `<p class="mui-replay__stat"><span class="mui-replay__stat-label">${tr('context.inWindow')}</span><span class="mui-replay__stat-value">${calls ? fmt(lastPrompt) + ' tok' : '—'}</span></p>` +
      `<p class="mui-replay__stat"><span class="mui-replay__stat-label">${tr('context.spent')}</span><span class="mui-replay__stat-value">${calls ? fmt(spent) + ' tok' : '—'}</span></p>` +
      `<p class="mui-replay__stat"><span class="mui-replay__stat-label">${tr('context.modelCalls')}</span><span class="mui-replay__stat-value">${calls || '—'}</span></p>` +
      `<p class="mui-replay__stat"><span class="mui-replay__stat-label">${tr('context.cached')}</span><span class="mui-replay__stat-value">${cached ? fmt(cached) + ' tok' : '0'}</span></p>`
  }
  const fill = $('#ctx-fill')
  if (fill) {
    const win = ctxWindow()
    if (!calls) { fill.innerHTML = `<p class="dv-note">${tr('context.noCalls')}</p>` }
    else if (!win) { fill.innerHTML = `<p class="dv-note">${tr('context.declareWindow', { tokens: fmt(lastPrompt) })}</p>` }
    else {
      const pct = Math.min(100, Math.round(lastPrompt / win * 100))
      const left = Math.max(0, win - lastPrompt)
      const hue = pct >= 85 ? 'var(--danger, #c0562f)' : pct >= 60 ? 'var(--warning, #b8860b)' : 'var(--olivo, #7a8b5a)'
      fill.innerHTML =
        `<div class="mui-cluster mui-cluster--sm" style="justify-content:space-between"><span class="dv-note">${fmt(lastPrompt)} / ${fmt(win)} tok</span><span class="dv-note">${pct}% · faltan ${fmt(left)}</span></div>` +
        `<div style="height:8px;border-radius:999px;background:var(--surface-sunken,var(--border-subtle));overflow:hidden;margin-top:4px"><div style="height:100%;width:${pct}%;background:${hue};transition:width var(--dur-moderate,.3s) var(--ease-grano,ease)"></div></div>`
    }
  }
}

// ── DebtSignal panel (greenhouse decisions/0183, primitive #5) ───────────────────────────────────────────
// The backend admits debt as it works — `session.debt_signaled` facts in the stream. The Inspector
// projects them as counts per kind, most-frequent first, recounted from the events array on demand
// (no state of its own). No signals → no panel: absence stays quiet. The counting is pure
// (debt.js / window.milpaDebt) so it can be exercised headless against a synthetic stream.
let debtBusy = false
function debtKindLabel (kind) {
  const key = 'debt.kind.' + kind
  const label = tr(key)
  return label === key ? String(kind).replace(/_/g, ' ') : label   // humanized snake_case fallback
}
function renderDebtPanel (counts) {
  const box = $('#inspector-body'); if (!box) return
  const old = box.querySelector('#debt-panel'); if (old) old.remove()
  if (!counts.length) return                          // empty state: the panel stays hidden, never noise
  const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const rows = counts.map(c => `<div class="mui-cluster mui-cluster--sm"><span class="mui-badge mui-badge--warning">${c.count} ×</span><span class="dv-note">${esc(debtKindLabel(c.kind))}</span></div>`).join('')
  box.append(html(`<div id="debt-panel"><p class="mui-section__kicker" style="margin:0 0 var(--space-2)">${tr('inspector.debt')}</p><div class="mui-stack mui-stack--sm">${rows}</div></div>`))
}
async function refreshDebt () {
  if (!bridge || debtBusy || !window.milpaDebt) return
  debtBusy = true
  try {
    const { events } = await bridge.events(current, 0)
    renderDebtPanel(window.milpaDebt.countDebtSignals(events || []))
  } catch { /* a read failure keeps the last projection */ }
  debtBusy = false
}

// ── Decisiones screen (the session's gate, decisions and permissions — consent/gate/attribution) ─
function renderDecisiones (show) {
  const scr = document.querySelector('[data-screen="decisiones"]'); if (!scr) return
  const q = show && show.question
  const decisions = (show && show.decisions) || []
  const perms = (show && show.permissions) || []

  let gate = `<div class="mui-card"><div class="mui-card__body"><p class="dv-note">${tr('decisions.none')}</p></div></div>`
  if (q) {
    let op = q.operation || q.tool || '—', args = ''
    try { const w = typeof q.why === 'string' ? JSON.parse(q.why) : (q.why || {}); if (w.operation) op = w.operation; if (w.arguments) args = fmtArgs(w.arguments) } catch {}
    gate = `<div class="mui-card mui-card--raised" style="border-color:var(--warning-border);background:var(--warning-bg)"><div class="mui-card__body mui-gate">
      <div class="mui-gate__request"><p class="mui-gate__actor" style="margin:0">el gate detuvo la vuelta · pregunta durable, no un modal</p>
      <p class="mui-gate__action" style="margin:var(--space-1) 0">${clean(md(cleanQuestion(q.question) || tr('gate.authRequired')))}</p>
      <p class="mui-gate__facts" style="margin:0">${tr('gate.operation')} <strong>${op}</strong>${args ? ' · ' + args : ''} · ${tr('gate.reason')}: <strong>${q.reason || '—'}</strong> · ${tr('gate.authority')} · ${tr('gate.signature')}: <strong>${tr('gate.notPresented')}</strong></p></div>
      <div class="mui-gate__decisions" id="dec-gate-actions">
        <button type="button" class="mui-btn mui-btn--primary mui-btn--sm" data-dd="sí">${tr('gate.authorize')}</button>
        <button type="button" class="mui-btn mui-btn--danger mui-btn--sm" data-dd="no">${tr('gate.deny')}</button></div>
      <p class="dv-note" style="margin:0">${tr('gate.note')}</p></div></div>`
  }

  const decList = decisions.length
    ? decisions.map(d => {
      const question = (d && (d.question || d.text || d.title || d.decision || d.summary)) || ''
      const expired = d && d.expired
      const answer = d && d.answer
      const label = expired ? tr('decisions.expired') : (answer != null && answer !== '' ? String(answer) : '')
      const badge = label ? `<span class="mui-badge ${expired ? 'mui-badge--danger' : 'mui-badge--success'}" style="margin-left:var(--space-2)">${clean(String(label).slice(0, 40))}</span>` : ''
      const body = question ? clean(md(String(question).slice(0, 200))) : tr('decisions.noneYet')
      return `<div class="mui-card mui-card--compact"><div class="mui-card__body"><p style="margin:0;font-size:var(--text-sm)">${body}${badge}</p></div></div>`
    }).join('')
    : `<p class="dv-note">${tr('decisions.noneYet')}</p>`

  const permList = perms.length
    ? perms.map(p => { const name = p.operation || p.name || p.tool || p; const g = (p.status || p.grant || '').toString(); const b = g.match(/grant|otorg/) ? 'mui-badge--success' : g.match(/sign|firma/) ? 'mui-badge--warning' : g.match(/retir|revok/) ? 'mui-badge--danger' : ''; return `<div class="mui-cluster mui-cluster--sm" style="justify-content:space-between"><span class="dv-note">${name}</span>${g ? `<span class="mui-badge ${b}">${g}</span>` : `<button type="button" class="mui-btn mui-btn--sm perm-view">${tr('perm.view')}</button>`}</div>` }).join('')
    : `<p class="dv-note">${tr('decisions.noPerms')}</p>`

  scr.innerHTML = `<div class="mui-stack">
    <div><p class="mui-section__kicker" style="margin:0 0 var(--space-2)">${tr('decisions.pending')}</p>${gate}${(q && !ownerVerified) ? `<p class="dv-note" style="margin:var(--space-2) 0 0">Sin llave, la casa registra <strong>QUE</strong> autorizaste (<code>cli:desconocido</code>, no verificado), no <strong>QUIÉN</strong>. <a href="#" id="dec-enroll-hint">Enrola una llave en Identidad</a> para firmar tus decisiones — el enrolamiento es un acto firmado, no un login.</p>` : ''}</div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-5);align-items:start">
      <div><p class="mui-section__kicker" style="margin:0 0 var(--space-2)">${tr('decisions.sessionDecisions')} · ${decisions.length}</p><div class="mui-stack mui-stack--sm">${decList}</div></div>
      <div><p class="mui-section__kicker" style="margin:0 0 var(--space-2)">${tr('decisions.permsAttribution')}</p><div class="mui-stack mui-stack--sm">${permList}</div></div>
    </div></div>`

  const hint = scr.querySelector('#dec-enroll-hint')
  if (hint) hint.addEventListener('click', (e) => { e.preventDefault(); openIdentity() })
  const acts = scr.querySelector('#dec-gate-actions')
  if (acts) acts.querySelectorAll('[data-dd]').forEach(b => b.addEventListener('click', async () => {
    acts.querySelectorAll('button').forEach(x => x.disabled = true)
    await bridge.answer(current, b.dataset.dd)
    acts.innerHTML = `<span class="mui-badge mui-badge--success">${tr('gate.answered', { answer: b.dataset.dd })}</span>`
    // Authorizing IS the intent to continue — one step, not two (Rod's principle: never re-specify
    // what the system can infer). Same as the conversation gate: a "yes" resumes the work; a "no"
    // only records the answer. So a human who authorized never has to also press «Continue».
    if (b.dataset.dd === 'sí') { await refreshShow(); send('continúa') } else { refreshShow() }
  }))
}

// ── Components screen — hosts a Milpa LIVE WEB COMPONENT rendered by the framework (a Desktop screen authored
// the Milpa way, not hand-written here). The container renders the signed <milpa-state> + Alpine markup; the
// shell injects it (greenhouse decisions/0142). Making it fully reactive (Alpine wired) is the next slice.
// A hosted component's HTML arrives by IPC AFTER Alpine already walked the document at boot, so its
// x-data subtree is inert until we initialize it explicitly. This is the seam: the runtime being
// loaded is not enough — the late-injected tree must be hydrated. LOCAL runtime only (ADR#9): the
// factories carry local state + persistence, no network.
function hydrateLive (host) {
  const A = window.Alpine
  if (A && typeof A.initTree === 'function') { try { A.initTree(host) } catch (e) { /* inert host is acceptable */ } }
}

// The renderer is file://, so the remote runtime cannot fetch the container directly. Bridge its POST
// through IPC (main → container). Set once, after the runtimes have created window.MilpaLive.
function ensureLiveTransport () {
  if (window.MilpaLive && bridge && bridge.live && typeof window.MilpaLive.transport !== 'function') {
    window.MilpaLive.transport = function (boot, requestBody) { return bridge.live(boot.endpoint, requestBody) }
  }
}

// The live PREVIEW pane (greenhouse Desktop, Rod 2026-08-29): "see what the agent is building". Any screen
// the agent authored (screen:declare) is served by the container's live door; here the human picks a name and
// watches it render live, hydrated, with its actions round-tripping over the bridge. "¿Cómo se ve?", answered
// in the same app where the agent builds it.
async function renderComponents () {
  const scr = document.querySelector('[data-screen="componentes"]'); if (!scr) return
  const host = scr.querySelector('#component-host'); if (!host || !bridge || !bridge.component) return
  const input = scr.querySelector('#preview-name')
  const go = scr.querySelector('#preview-go')
  if (go && !go.dataset.wired) {                              // wire the picker once — button + Enter re-preview
    go.dataset.wired = '1'
    const run = () => previewComponent(host, input)
    go.addEventListener('click', run)
    if (input) input.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); run() } })
  }
  previewComponent(host, input)
}

async function previewComponent (host, input) {
  const name = (input && input.value.trim()) || 'tasks'      // default: the demo screen the agent authored
  ensureLiveTransport()                                       // route the hosted component's actions through the bridge
  host.innerHTML = `<div class="mui-card__body"><p class="dv-note">${tr('components.loading')}</p></div>`
  const r = await bridge.component(name).catch(() => ({ ok: false }))
  if (r && r.ok && r.html) {
    host.innerHTML = r.html                                   // host the Milpa live web component (remote-capable)
    hydrateLive(host)                                         // bring it to life; the remote runtime drives its actions over the bridge
  }
  else host.innerHTML = `<div class="mui-card__body"><p class="dv-note">${tr('components.error')}</p></div>`
}

// ── Capacidades screen (what the app can do, and enabling more — a signed, app-changing act) ──────
async function renderAgents () {
  const scr = document.querySelector('[data-screen="agentes"]'); if (!scr || !bridge || !bridge.roles) return
  scr.innerHTML = `<p class="mui-section__kicker">${tr('nav.agents')}</p><p class="dv-note">${tr('agents.reading')}</p>`
  const r = await bridge.roles().catch(() => null)
  if (!r || r.ok === false) { scr.innerHTML = `<p class="mui-section__kicker">${tr('nav.agents')}</p><p class="dv-note">${tr('agents.readError')}</p>`; return }
  const roles = r.roles || []
  const chips = (arr, cls) => (arr || []).map(x => `<span class="mui-badge ${cls}">${clean(String(x))}</span>`).join(' ')
  const cards = roles.length
    ? roles.map(a => {
        const skills = (a.skills && a.skills.length) ? `<div class="mui-cluster mui-cluster--sm" style="margin-top:var(--space-2)"><span class="dv-note">${tr('agents.skills')}</span> ${chips(a.skills, 'mui-badge--success')}</div>` : ''
        const denies = (a.deny && a.deny.length) ? `<div class="mui-cluster mui-cluster--sm" style="margin-top:var(--space-1)"><span class="dv-note">${tr('agents.denies')}</span> ${chips(a.deny, 'mui-badge--danger')}</div>` : ''
        const produces = a.produces ? `<div class="mui-cluster mui-cluster--sm" style="margin-top:var(--space-1)"><span class="dv-note">${tr('agents.produces')}</span> <span class="mui-badge mui-badge--warning">${clean(String(a.produces))}</span></div>` : ''
        return `<div class="mui-card mui-card--compact"><div class="mui-card__body">
          <span style="font-family:var(--font-mono);font-size:var(--text-sm)">${clean(a.name)}</span>
          ${skills}${denies}${produces}</div></div>`
      }).join('')
    : `<p class="dv-note">${tr('agents.none')}</p>`
  const form = `<details class="mui-card mui-card--compact" style="margin-bottom:var(--space-4)"><summary style="cursor:pointer;padding:var(--space-1) 0"><span class="mui-badge mui-badge--success">+</span> <span class="dv-note">${tr('agents.compose')}</span></summary>
    <div class="mui-stack mui-stack--sm" style="margin-top:var(--space-3)">
      <input class="mui-input mui-input--sm" id="ag-name" placeholder="${tr('agents.fName')}" style="font-family:var(--font-mono)">
      <textarea class="mui-textarea" id="ag-prompt" placeholder="${tr('agents.fPrompt')}" rows="3"></textarea>
      <input class="mui-input mui-input--sm" id="ag-skills" placeholder="${tr('agents.fSkills')}">
      <input class="mui-input mui-input--sm" id="ag-deny" placeholder="${tr('agents.fDeny')}">
      <input class="mui-input mui-input--sm" id="ag-produces" placeholder="${tr('agents.fProduces')}">
      <div class="mui-cluster mui-cluster--sm" style="justify-content:space-between;align-items:center"><span class="dv-note" id="ag-msg"></span><button type="button" class="mui-btn mui-btn--primary mui-btn--sm" id="ag-declare">${tr('agents.declare')}</button></div>
    </div></details>`
  scr.innerHTML = `<div class="mui-stack"><div><p class="mui-section__kicker" style="margin:0">${tr('nav.agents')}</p><p class="dv-note" style="margin:var(--space-1) 0 0">${tr('agents.intro')}</p></div>${form}${cards}</div>`
  const btn = document.getElementById('ag-declare')
  if (btn) btn.addEventListener('click', async () => {
    const val = (id) => (document.getElementById(id)?.value || '').trim()
    const list = (id) => val(id).split(',').map(x => x.trim()).filter(Boolean)
    const msg = document.getElementById('ag-msg')
    const input = { name: val('ag-name'), prompt: val('ag-prompt'), skills: list('ag-skills'), deny: list('ag-deny'), produces: val('ag-produces') }
    if (!input.name || !input.prompt) { if (msg) msg.textContent = tr('agents.needBrief'); return }
    if (msg) msg.textContent = '…'
    const r = await bridge.declareRole(input).catch(() => null)
    if (r && r.ok) { renderAgents() } else if (msg) { msg.textContent = (r && r.error) || tr('agents.declareFail') }
  })
}

async function renderSkills () {
  const scr = document.querySelector('[data-screen="skills"]'); if (!scr || !bridge || !bridge.skills) return
  scr.innerHTML = `<p class="mui-section__kicker">${tr('nav.skills')}</p><p class="dv-note">${tr('skills.reading')}</p>`
  const r = await bridge.skills().catch(() => null)
  if (!r || r.ok === false) { scr.innerHTML = `<p class="mui-section__kicker">${tr('nav.skills')}</p><p class="dv-note">${tr('skills.readError')}</p>`; return }
  const skills = r.skills || []
  const cards = skills.length
    ? skills.map(s => {
        const who = s.modelInvocable && s.userInvocable ? tr('skills.both') : (s.modelInvocable ? tr('skills.agentOnly') : tr('skills.humanOnly'))
        const cls = s.modelInvocable ? 'mui-badge--success' : 'mui-badge--warning'
        return `<div class="mui-card mui-card--compact"><div class="mui-card__body">
          <div class="mui-cluster mui-cluster--sm" style="justify-content:space-between;align-items:center">
            <span style="font-family:var(--font-mono);font-size:var(--text-sm)">${clean(s.name)}</span>
            <span class="mui-badge ${cls}">${who}</span></div>
          <p class="dv-note" style="margin-top:var(--space-2)">${clean(String(s.description).slice(0, 260))}</p></div></div>`
      }).join('')
    : `<p class="dv-note">${tr('skills.none')}</p>`
  scr.innerHTML = `<div class="mui-stack"><div><p class="mui-section__kicker" style="margin:0">${tr('nav.skills')}</p><p class="dv-note" style="margin:var(--space-1) 0 0">${tr('skills.intro')}</p></div>${cards}</div>`
}

async function renderCapacidades () {
  const scr = document.querySelector('[data-screen="capacidades"]'); if (!scr || !bridge || !bridge.capabilities) return
  scr.innerHTML = `<p class="mui-section__kicker">${tr('nav.capabilities')}</p><p class="dv-note">${tr('capabilities.reading')}</p>`
  const c = await bridge.capabilities().catch(() => null)
  if (!c || c.ok === false) { scr.innerHTML = `<p class="dv-note">${tr('capabilities.readError')}</p>`; return }
  const installed = c.installed || []
  const available = c.available || []
  const nameOf = x => x.id || x.capability || x.name || x.package || String(x)

  const instCards = installed.length
    ? installed.map(x => `<div class="mui-card mui-card--compact"><div class="mui-card__body"><div class="mui-cluster mui-cluster--sm" style="justify-content:space-between"><span style="font-family:var(--font-mono);font-size:var(--text-xs)">${nameOf(x)}</span><span class="mui-badge mui-badge--success">${tr('capabilities.installed')}</span></div>${x.provides ? `<p class="dv-note" style="margin-top:var(--space-2)">${clean(String(x.provides).slice(0, 140))}</p>` : ''}</div></div>`).join('')
    : `<p class="dv-note">${tr('capabilities.onlyCatalogue')}</p>`

  const availCards = available.length
    ? available.map(x => { const id = nameOf(x); return `<div class="mui-card mui-card--compact"><div class="mui-card__body"><div class="mui-cluster mui-cluster--sm" style="justify-content:space-between"><span style="font-family:var(--font-mono);font-size:var(--text-xs)">${id}</span><button type="button" class="mui-btn mui-btn--primary mui-btn--sm" data-enable="${id}">${tr('capabilities.enable')}</button></div>${x.unlocks ? `<p class="dv-note" style="margin-top:var(--space-2)">${clean(String(x.unlocks).slice(0, 140))}</p>` : ''}</div></div>` }).join('')
    : `<p class="dv-note">${tr('capabilities.nothingElse')}</p>`

  scr.innerHTML = `<div class="mui-stack">
    <div><p class="mui-section__kicker" style="margin:0">${tr('capabilities.sourceLine', { source: c.source || '—' })}</p><p class="dv-note" style="margin:var(--space-1) 0 0">${tr('capabilities.intro')}</p></div>
    <div style="display:grid;grid-template-columns:1fr 1fr;gap:var(--space-5);align-items:start">
      <div><p class="mui-section__kicker" style="margin:0 0 var(--space-2)">${tr('capabilities.installedCount')} · ${installed.length}</p><div class="mui-stack mui-stack--sm">${instCards}</div></div>
      <div><p class="mui-section__kicker" style="margin:0 0 var(--space-2)">${tr('capabilities.availableCount')} · ${available.length}</p><div class="mui-stack mui-stack--sm">${availCards}</div></div>
    </div>
    <p class="dv-note" id="cap-msg"></p></div>`

  scr.querySelectorAll('[data-enable]').forEach(b => b.addEventListener('click', async () => {
    b.disabled = true; b.textContent = 'Firmando…'
    const r = await bridge.enableCapability(b.dataset.enable).catch(e => ({ ok: false, error: String(e) }))
    const msg = $('#cap-msg')
    if (msg) msg.textContent = r && r.ok ? `Habilitada ${b.dataset.enable}${r.unlocked ? ' · desbloquea: ' + (Array.isArray(r.unlocked) ? r.unlocked.join(', ') : r.unlocked) : ''}` : `No se pudo: ${r && (r.error || 'firma declinada o sin efecto')}`
    renderCapacidades()
  }))
}

// ── Activity panel (the raw stream) ─────────────────────────────────────────────────────────────
async function renderActivity () {
  const p = $('[data-panel="actividad"]'); if (!p || !bridge) return
  const { events } = await bridge.events(current, 0)
  const esc = (x) => String(x).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  const label = { 'session.started': tr('activity.started'), 'session.turn': tr('activity.turn'), 'session.model_called': tr('activity.modelCall'), 'session.model_returned': tr('activity.modelReturned'), 'session.tool_called': tr('activity.toolCall'), 'session.system_set': tr('activity.system'), 'session.question_asked': tr('activity.question') }
  const rows = events.slice(-80).map(e => {
    // The system prompt is a first-class audit row: the EXACT text the agent received — skills included.
    if (e.type === 'session.system_set' && e.payload.system) {
      return `<details class="mui-card mui-card--compact" style="margin-block:var(--space-1)"><summary style="cursor:pointer;padding:var(--space-1) 0"><span class="mui-badge mui-badge--success">${tr('activity.system')}</span> <span class="dv-note">${tr('activity.systemHint')}</span></summary><pre style="white-space:pre-wrap;font-size:var(--text-xs);font-family:var(--font-mono);margin:var(--space-2) 0 0;max-height:440px;overflow:auto;color:var(--text-secondary)">${esc(e.payload.system)}</pre></details>`
    }
    const detail = (e.payload.tool || e.payload.model || e.payload.role || '').toString().slice(0, 40)
    return `<div class="mui-cluster mui-cluster--sm" style="justify-content:space-between;border-bottom:1px solid var(--border-subtle);padding-block:var(--space-1)"><span class="dv-note">${label[e.type] || e.type}</span><span class="dv-note" style="color:var(--text-secondary)">${esc(detail)}</span></div>`
  }).join('')
  p.innerHTML = `<p class="mui-section__kicker" style="margin:0 0 var(--space-3)">${tr('activity.log', { n: events.length })}</p><div class="mui-stack mui-stack--sm">${rows}</div>`
}

// ── sidebar sessions ────────────────────────────────────────────────────────────────────────────
async function refreshSessions () {
  if (!bridge) return
  const r = await bridge.show(current).catch(() => null)
  const list = $('#session-list'); list.innerHTML = ''
  const a = el('a', { className: 'mui-sidebar__item', href: '#' }); a.style.cssText = 'flex-direction:column;align-items:flex-start;gap:2px;height:auto;padding-block:var(--space-2);background:var(--accent-subtle)'
  a.innerHTML = `<span style="font-size:var(--text-xs)">${(r?.goal || current).slice(0, 36)}</span><span class="mui-badge ${r?.question ? 'mui-badge--warning mui-badge--dot' : 'mui-badge--dot'}">${r?.question ? tr('session.badge.waiting') : (r?.turns ? tr('session.badge.active') : tr('session.badge.new'))}</span>`
  list.append(a)
}

// ── session audit export: split the stream into its components and weigh each one, so a human can
// SEE where the token budget goes and debug it with the house ────────────────────────────────────
function estTok (s) { return Math.round((typeof s === 'string' ? s : JSON.stringify(s || '')).length / 4) }
function findInPayload (o, keys) {
  if (o && typeof o === 'object') {
    for (const k of Object.keys(o)) {
      if (keys.includes(k)) return o[k]
      const r = findInPayload(o[k], keys); if (r !== undefined && r !== null) return r
    }
  }
  return null
}
function kfmt (n) { return n >= 1000 ? (n / 1000).toFixed(n >= 10000 ? 0 : 1) + 'k' : String(n) }

async function exportSession () {
  const btn = $('#export-btn'); const label0 = btn ? btn.textContent : ''
  if (btn) { btn.disabled = true; btn.textContent = 'Exportando…' }
  try {
    const [evres, show] = await Promise.all([bridge.events(current, 0), bridge.show(current)])
    const events = (evres && evres.events) || []
    if (!events.length) { if (btn) { btn.textContent = 'sin eventos'; setTimeout(() => { btn.textContent = label0; btn.disabled = false }, 1500) } return }

    // Real provider usage (session.model_returned), and estimated weight per component (~4 chars/tok).
    let spent = 0, lastPrompt = 0, cached = 0, calls = 0
    const comp = { user: [0, 0], assistant: [0, 0], reasoning: [0, 0], toolResult: [0, 0], toolCall: [0, 0], summary: [0, 0], system: [0, 0] }
    let heaviestResult = { t: 0, tool: '' }
    let heaviestCall = null, heaviestCallLen = 0
    const line = []

    for (const e of events) {
      const p = e.payload || {}
      if (e.type === 'session.turn' && p.role === 'user') { const t = estTok(p.content); comp.user[0]++; comp.user[1] += t; line.push({ k: 'user', t, body: String(p.content || '') }) } else if (e.type === 'session.turn' && p.role === 'assistant') { const t = estTok(p.content); comp.assistant[0]++; comp.assistant[1] += t; line.push({ k: 'assistant', t, body: String(p.content || '') }) } else if (e.type === 'session.model_reasoned') { const t = estTok(p.reasoning); comp.reasoning[0]++; comp.reasoning[1] += t; line.push({ k: 'reasoning', t, body: String(p.reasoning || '') }) } else if (e.type === 'session.tool_called') {
        const rt = estTok(p.result); const at = estTok((p.tool || '') + ' ' + JSON.stringify(p.args || p.arguments || {}))
        comp.toolResult[0]++; comp.toolResult[1] += rt; comp.toolCall[0]++; comp.toolCall[1] += at
        if (rt > heaviestResult.t) heaviestResult = { t: rt, tool: p.tool || '?' }
        line.push({ k: 'tool', t: rt, tool: p.tool || '?', args: p.args || p.arguments || {}, body: String(p.result || '') })
      } else if (e.type === 'session.compacted') { const t = estTok(p.summary); comp.summary = [1, t]; line.push({ k: 'summary', t, through: p.through, body: String(p.summary || '') }) } else if (e.type === 'session.model_returned') { const u = (p.usage && typeof p.usage === 'object') ? p.usage : p; spent += (u.total_tokens || 0); if (u.prompt_tokens) lastPrompt = u.prompt_tokens; cached += (u.cached_tokens || 0); calls++ } else if (e.type === 'session.model_called') { const len = JSON.stringify(p).length; if (len > heaviestCallLen) { heaviestCallLen = len; heaviestCall = p } }
    }

    // The heaviest single request: what ONE call actually sent, broken down.
    let heavy = null
    if (heaviestCall) {
      const sys = findInPayload(heaviestCall, ['system'])
      const tools = findInPayload(heaviestCall, ['tools'])
      const msgs = findInPayload(heaviestCall, ['messages', 'mensajes']) || []
      if (sys) comp.system = [1, estTok(sys)]
      const byRole = {}
      for (const m of (Array.isArray(msgs) ? msgs : [])) { if (!m || typeof m !== 'object') continue; const r = m.role || '?'; byRole[r] = (byRole[r] || 0) + estTok(m.content) }
      heavy = { total: estTok(heaviestCall), system: estTok(sys || ''), tools: estTok(tools || ''), toolsN: Array.isArray(tools) ? tools.length : 0, msgs: byRole }
    }

    // ── compose the markdown ──
    const rows = [
      ['resultados de tool', comp.toolResult, heaviestResult.t ? `el más pesado: ${heaviestResult.tool} ~${kfmt(heaviestResult.t)}` : ''],
      ['razonamiento (thinking)', comp.reasoning, 'lo que el modelo piensa por turno'],
      ['resumen de sesión', comp.summary, 'la compactación (se re-manda cada llamada)'],
      ['system prompt', comp.system, 'se manda cada llamada'],
      ['turnos asistente', comp.assistant, ''],
      ['llamadas a tool (args)', comp.toolCall, ''],
      ['turnos usuario', comp.user, '']
    ].sort((a, b) => b[1][1] - a[1][1])

    let md = `# Auditoría de sesión — ${current}\n\n`
    md += `Modelo: **${(show && show.model) || 'qwen'}** · Turnos: **${(show && show.turns) ?? '?'}** · Compactado hasta seq: **${(show && show.compactedThrough) ?? 'no'}** · Eventos: **${events.length}**\n\n`
    md += `## 1. Presupuesto REAL (del proveedor · session.model_returned)\n\n`
    md += `- **Total gastado:** ${kfmt(spent)} tokens (suma de \`total_tokens\` de ${calls} llamadas)\n`
    md += `- **Última ventana (prompt):** ${kfmt(lastPrompt)} tokens${cached ? ` · cacheado: ${kfmt(cached)}` : ''}\n\n`
    md += `## 2. Dónde se van los tokens — estimado por componente (~4 chars/token)\n\n`
    md += `Esto es lo que RECURRE en la ventana cada llamada. Ordenado por peso:\n\n`
    md += `| componente | ~tokens | # | nota |\n|---|---:|---:|---|\n`
    for (const [name, [n, t], note] of rows) md += `| ${name} | **${kfmt(t)}** | ${n} | ${note} |\n`
    md += `\n`
    if (heavy) {
      md += `## 3. La llamada MÁS PESADA — qué mandó UNA sola llamada (~${kfmt(heavy.total)} tok)\n\n`
      md += `- system: ~${kfmt(heavy.system)} · tools: ~${kfmt(heavy.tools)} (${heavy.toolsN} tools)\n`
      md += `- mensajes por rol: ${Object.entries(heavy.msgs).map(([r, t]) => `${r} ~${kfmt(t)}`).join(' · ')}\n\n`
      md += `> Si un rol (típicamente \`tool\`) domina, ahí está la fuga: un resultado gordo re-enviado cada llamada.\n\n`
    }
    md += `## 4. Timeline auditable (cada componente, separado, con su peso)\n\n`
    const icon = { user: '👤 USUARIO', assistant: '🤖 ASISTENTE', reasoning: '🧠 THINKING', tool: '🔧 TOOL', summary: '📦 RESUMEN (compactación)' }
    for (const it of line) {
      if (it.k === 'tool') {
        md += `### 🔧 ${it.tool} → resultado · ~${kfmt(it.t)} tok\n`
        md += `**args:** \`${JSON.stringify(it.args).slice(0, 400)}\`\n\n\`\`\`\n${it.body}\n\`\`\`\n\n`
      } else {
        md += `### ${icon[it.k] || it.k}${it.through != null ? ' · hasta seq ' + it.through : ''} · ~${kfmt(it.t)} tok\n\n`
        md += (it.k === 'reasoning' || it.k === 'summary') ? `${it.body}\n\n` : `> ${String(it.body).replace(/\n/g, '\n> ')}\n\n`
      }
    }

    const res = await bridge.saveExport(`milpa-${current}`, md)
    if (btn) { btn.textContent = (res && res.ok) ? '✓ guardado' : (res && res.canceled ? label0 : 'error'); btn.disabled = false; if (res && res.ok) setTimeout(() => { btn.textContent = label0 }, 2000) }
  } catch (e) {
    if (btn) { btn.textContent = 'error'; btn.disabled = false; setTimeout(() => { btn.textContent = label0 }, 2000) }
  }
}

// ── chrome ──────────────────────────────────────────────────────────────────────────────────────
function setLive (state, label) {
  if (Date.now() < compactingUntil) return   // hold the "Compacting…" flash; the next poll restores this
  const dot = { working: '◍', wait: '◉', idle: '◉', err: '◉', connecting: '◌' }[state] || '◌'
  const color = { wait: 'var(--warning)', err: 'var(--danger)', idle: 'var(--success)', working: 'var(--accent)' }[state] || 'var(--text-muted)'
  const s = $('#st-live'); s.textContent = `${dot} ${label}`; s.style.color = color
}

// A fresh compaction just landed — flash the live indicator so the human sees the window was
// shrunk. Compaction is local and instant (it reads the session facts, no model call), so this is
// a brief acknowledgement, not a progress bar: it holds ~2.5s, then the next poll restores the state.
function flashCompacting () {
  compactingUntil = Date.now() + 2500
  const s = $('#st-live'); if (s) { s.textContent = `◍ ${tr('live.compacting')}`; s.style.color = 'var(--accent)' }
}
document.querySelectorAll('[data-tab]').forEach(t => t.addEventListener('click', () => {
  document.querySelectorAll('[data-tab]').forEach(x => x.setAttribute('aria-selected', String(x === t)))
  document.querySelectorAll('[data-panel]').forEach(p => { p.hidden = p.dataset.panel !== t.dataset.tab })
  if (t.dataset.tab === 'actividad') renderActivity()
}))
document.querySelectorAll('[data-nav]').forEach(n => n.addEventListener('click', (e) => {
  e.preventDefault(); document.querySelectorAll('[data-nav]').forEach(x => x.removeAttribute('aria-current')); n.setAttribute('aria-current', 'page')
  const v = n.dataset.nav; document.querySelectorAll('[data-screen]').forEach(s => { s.hidden = s.dataset.screen !== v })
  $('#chat-screen').hidden = !(v === 'sesiones')
  if (v === 'decisiones' && lastShow) renderDecisiones(lastShow)
  if (v === 'capacidades') renderCapacidades()
  if (v === 'componentes') renderComponents()
  if (v === 'skills') renderSkills()
  if (v === 'agentes') renderAgents()
}))
document.addEventListener('click', (e) => {
  const v = e.target.closest && e.target.closest('.perm-view'); if (!v) return
  e.preventDefault(); const nav = document.querySelector('[data-nav="decisiones"]'); if (nav) nav.click()
})
$('#theme-toggle').addEventListener('click', () => { const h = document.documentElement; h.dataset.theme = h.dataset.theme === 'light' ? 'dark' : 'light' })
$('#send').addEventListener('click', () => { $('#send').dataset.stop ? stopAgent() : send() })
$('#query').addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) send() })
$('#new-session')?.addEventListener('click', () => {
  // A fresh session id — the store creates it on the first drive. Reuses no context, no compaction.
  try { localStorage.setItem('milpa.session', 'work-' + Date.now().toString(36)) } catch {}
  location.reload()
})
$('#inspector-toggle')?.addEventListener('click', () => { $('#inspector').hidden = !$('#inspector').hidden })
$('#export-btn')?.addEventListener('click', exportSession)

;(async () => {
  setLive('connecting', tr('live.connecting'))
  if (!bridge) { setLive('err', 'Sin puente (abre en Milpa Desktop)'); return }
  const st = await bridge.status()
  $('#model-chip').textContent = `${st.model.name} · local`; $('#st-model').textContent = `${st.model.name} · modelo local`
  $('#st-version').textContent = `m4-core local-agent · v${st.version}`
  setLive(st.backend ? 'idle' : 'connecting', st.backend ? tr('live.live') : tr('live.booting'))
  // Auth/launch screen: the M germinates from its grains while the runtime comes up, then settles.
  const open = document.querySelector('#auth-open'); const sc = document.querySelector('#auth-sidecar'); const pl = document.querySelector('#a-prov-local')
  const auth = document.querySelector('#auth-screen'); const cap = document.querySelector('#loader-caption')
  if (pl) pl.textContent = `Modelo local · ${st.model.name} (${st.model.base.replace(/^https?:\/\//, '')})`
  // Remember the workspace was opened, so a reload lands back in it (not on the launch gate) with the
  // conversation already repainted from the stream — no huecos, no "perdió todo".
  let entered = false
  const enterWorkspace = () => {
    if (entered) return; entered = true
    try { localStorage.setItem('milpa.opened', '1') } catch {}
    const a = document.querySelector('#auth-screen'); if (a) a.remove()
    const app = document.querySelector('.app'); if (app) app.hidden = false
  }
  const wasOpened = () => { try { return localStorage.getItem('milpa.opened') === '1' } catch { return false } }
  await paintHistory()   // paint the transcript BEFORE any reveal, so the reload shows it with no flash
  const markReady = () => {
    setLive('idle', tr('live.live'))
    if (sc) sc.textContent = tr('launch.sidecarReady')
    if (cap) cap.textContent = tr('loader.ready')
    if (auth) auth.classList.remove('booting')   // the grains stop germinating; the M holds
    if (open) { open.disabled = false; open.textContent = tr('launch.open') }
    if (wasOpened()) enterWorkspace()   // returning user: skip the gate, go straight back into the app
  }
  if (st.backend) markReady()
  else {
    const boot = setInterval(async () => {
      const s = await bridge.status().catch(() => null)
      if (s && s.backend) { clearInterval(boot); markReady() }
    }, 900)
  }
  open?.addEventListener('click', enterWorkspace)
  const ep = document.querySelector('#set-endpoint'); if (ep) ep.value = st.model.base + '/v1'
  document.querySelectorAll('[data-lang-set]').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('[data-lang-set]').forEach(x => x.setAttribute('aria-pressed', String(x === b)))
    if (window.milpaI18n) window.milpaI18n.setLocale(b.dataset.langSet)
  }))
  // mark the active locale on load, and re-render dynamic copy when the locale changes
  { const cur = window.milpaI18n ? window.milpaI18n.locale : 'en'; const btn = document.querySelector(`[data-lang-set="${cur}"]`); if (btn) document.querySelectorAll('[data-lang-set]').forEach(x => x.setAttribute('aria-pressed', String(x === btn))) }
  window.addEventListener('milpa:locale', () => { if (typeof lastShow !== 'undefined' && lastShow) refreshShow() })
  document.querySelectorAll('[data-theme-set]').forEach(b => b.addEventListener('click', () => {
    document.querySelectorAll('[data-theme-set]').forEach(x => x.setAttribute('aria-pressed', String(x === b)))
    const v = b.dataset.themeSet; document.documentElement.dataset.theme = v === 'light' ? 'light' : 'dark'
  }))
  // Default autonomy: reflect the stored value (default `auto`), and persist on change AND on Save —
  // so the choice survives a reload and the next drive honors it (main.js reads the passed mode).
  const reflectAutonomy = () => { const cur = autonomyDefault(); document.querySelectorAll('[data-autonomy-set]').forEach(r => { r.checked = r.dataset.autonomySet === cur }) }
  reflectAutonomy()
  document.querySelectorAll('[data-autonomy-set]').forEach(r => r.addEventListener('change', () => {
    if (r.checked) { try { localStorage.setItem('milpa.autonomy', r.dataset.autonomySet === 'ask' ? 'ask' : 'auto') } catch {} ; if (typeof lastShow !== 'undefined' && lastShow) refreshShow() }
  }))
  const setSaved = document.querySelector('[data-i18n="settings.save"]')
  if (setSaved) setSaved.addEventListener('click', () => {
    const picked = document.querySelector('[data-autonomy-set]:checked')
    if (picked) { try { localStorage.setItem('milpa.autonomy', picked.dataset.autonomySet === 'ask' ? 'ask' : 'auto') } catch {} }
    if (typeof lastShow !== 'undefined' && lastShow) refreshShow()
  })
  const setDiscard = document.querySelector('[data-i18n="settings.discard"]')
  if (setDiscard) setDiscard.addEventListener('click', reflectAutonomy)
  refreshSessions(); refreshShow()
})()


// ── identity panel ──────────────────────────────────────────────────────────────────────────────
// Custody (software keys on the mounted host GNUPGHOME, or a YubiKey when reachable), «crear claves»,
// and the signed acts that turn a key into this session's recognized owner (greenhouse decisions/0121).
async function openIdentity () {
  const m = $('#id-modal'); if (!m) return
  m.hidden = false
  await loadIdentity()
}
function closeIdentity () { const m = $('#id-modal'); if (m) m.hidden = true }

async function loadIdentity () {
  if (!bridge || !bridge.keys) return
  const custody = $('#id-custody'), keysEl = $('#id-keys'), keygen = $('#id-keygen'), boot = $('#id-bootstrap')
  const k = await bridge.keys().catch(() => null)
  if (!k || !k.ok) { custody.textContent = 'No pude leer la custodia del contenedor.'; return }
  const label = { yubikey: '🔐 YubiKey conectada — custodia de hardware', software: '🔑 llave de software (host)', none: '◍ sin llaves — crea unas o conecta tu YubiKey' }
  custody.textContent = label[k.custody] || k.custody
  keysEl.innerHTML = (k.keys || []).map(x => {
    const fp = x.fingerprint || ''
    const short = fp.length > 12 ? fp.slice(0, 4) + '…' + fp.slice(-4) : fp
    return `<div class="mui-cluster mui-cluster--sm" style="justify-content:space-between;padding:4px 0" title="${fp}"><span class="dv-note">key:${short}${x.uid ? ' · ' + x.uid : ''}</span><button type="button" class="mui-btn mui-btn--ghost mui-btn--sm" data-revoke="${fp}">Revocar</button></div>`
  }).join('') || `<p class="dv-note">${tr('identity.noKeys')}</p>`
  keysEl.querySelectorAll('[data-revoke]').forEach(b => b.addEventListener('click', () => doRevoke(b.dataset.revoke)))
  // keygen only makes sense for the software path
  if (keygen) keygen.hidden = k.custody === 'yubikey'
  // show bootstrap as the first-root act only when there IS a key to become it
  if (boot) boot.hidden = !(k.keys && k.keys.length)
}

function idScopes () {
  const raw = ($('#id-scopes')?.value || '').trim()
  return raw ? raw.split(/[\s,]+/).filter(Boolean) : ['agent:read']
}
async function idMsg (t) { const el = $('#id-msg'); if (el) el.textContent = t }

async function doKeygen () {
  idMsg('Creando claves…')
  const r = await bridge.keygen().catch(e => ({ ok: false, error: String(e) }))
  idMsg(r && r.ok ? `Listo. Tu fingerprint: ${r.fingerprint}` : `No se pudo: ${r && (r.error || 'error')}`)
  await loadIdentity()
}
async function doBootstrap () {
  idMsg(tr('identity.bootstrapping'))
  const b = await bridge.signOp('identity:bootstrap', { scopes: idScopes() }).catch(e => ({ ok: false, error: String(e) }))
  if (!b || !b.ok) { idMsg(`Bootstrap: ${b && (b.error || 'sin efecto')}`); return }
  await doOwn(`Raíz creada (${b.fingerprint}). `)
}
async function doRevoke (fp) {
  if (!fp) return
  idMsg('Revocando ' + fp.slice(0, 8) + '…')
  const r = await bridge.signOp('identity:revoke', { fingerprint: fp }).catch(e => ({ ok: false, error: String(e) }))
  idMsg(r && r.ok ? ('Revocada: key:' + fp.slice(0, 8) + '… ya no se admite (el enrolamiento queda para auditoría).') : ('Revocar: ' + (r && (r.error || 'sin efecto'))))
  await loadIdentity()
  refreshOwner()
}

async function doOwn (prefix = '') {
  idMsg(prefix + tr('identity.owning'))
  const o = await bridge.signOp('session:own', { session: current }).catch(e => ({ ok: false, error: String(e) }))
  idMsg(prefix + (o && o.ok ? `Sesión tuya: ${o.owner}` : `Adueñar: ${o && (o.error || 'sin efecto')}`))
  refreshOwner()
}

document.addEventListener('DOMContentLoaded', () => {
  loadCatalogue()   // authoritative tool-mutation map for the tool cards
  $('#st-identity')?.addEventListener('click', openIdentity)
  $('#id-close')?.addEventListener('click', closeIdentity)
  $('#id-modal')?.addEventListener('click', (e) => { if (e.target && e.target.id === 'id-modal') closeIdentity() })
  $('#id-keygen')?.addEventListener('click', doKeygen)
  $('#id-enroll')?.addEventListener('click', () => doOwn())
  $('#id-bootstrap')?.addEventListener('click', doBootstrap)
})
