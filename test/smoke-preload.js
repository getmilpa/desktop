// Fixture window.milpa for the headless smoke test — canned data, no container.
const { contextBridge } = require('electron')
let statusCalls = 0
const FP = 'EAA59B1626D01F30E3DE271F9F5DBDDDD9BF7CE1'
// Scenarios keyed by `mode`: parked, a resolved but unverified closure, and a verified closure.
let mode = 'parked'
const unverifiedClosure = { verified: false, reasons: ['5 todos open'] }
const verifiedClosure = { verified: true, reasons: [] }
const question = { question: '¿Autorizo config:set?', why: JSON.stringify({ operation: 'config:set', arguments: { key: 'x' } }), reason: 'muta config', options: ['sí', 'no'] }
const show = {
  ok: true, goal: 'Smoke: construir el onramp', mode: 'ask', turns: 7, compactedThrough: 3,
  plan: '1. Leer 2. Habilitar 3. Verificar', todos: [{ text: 'Habilitar milpa/agent', status: 'active' }],
  permissions: [{ operation: 'plugins.enable', status: 'firmado' }, { operation: 'config.set', status: 'otorgado' }],
  decisions: ['Enrolar consume una raíz.', 'La sesión no acuña identidad.']
}
// A turn that ENDS IN A QUESTION: the model runs (model_called → «pensando»), then parks on a durable gate
// (question_asked). The two model_returned carry the honest token usage the Context tab reads.
const events = { total: 7, events: [
  { type: 'session.model_returned', payload: { model: 'qwen3.8-27b', usage: { prompt_tokens: 2140, completion_tokens: 18, total_tokens: 2158, cached_tokens: 0 } } },
  { type: 'session.model_returned', payload: { model: 'qwen3.8-27b', usage: { prompt_tokens: 6820, completion_tokens: 22, total_tokens: 6842, cached_tokens: 512 } } },
  { type: 'session.turn', payload: { role: 'user', content: 'Close the work.' } },
  { type: 'session.model_called', payload: { model: 'qwen3.8-27b' } },
  { type: 'session.turn', payload: { role: 'assistant', content: '🔧' } },
  { type: 'session.closure_derived', payload: unverifiedClosure },
  { type: 'session.question_asked', payload: { operation: 'foundation:found', reason: 'target_not_named' } }
] }
const doneEvents = { total: 2, events: events.events.slice(0, 2) }  // token telemetry only, no pending question
// THE HUB (greenhouse decisions/0508). A `hub` query: subscribe says live, the hub pushes two reasoning deltas while
// the model is still writing, then rings once for the stored facts (the full reasoning + a tool call), and the drive
// resolves 4 s later. `nohub` / `hubdrop` are the controls: no hub at all (the renderer must poll), and a hub that
// goes away mid-turn (the renderer must fall back to polling). `eventsCalls` is what tells a push from a poll.
let hubCb = null
let hubScenario = null   // 'hub' | 'nohub' | 'hubdrop'
let eventsCalls = 0
const hubFacts = [
  { type: 'session.model_reasoned', payload: { reasoning: 'Thinking about the plugins, then counting them.' } },
  { type: 'session.tool_called', payload: { tool: 'plugins_list', args: {}, result: 'ok' } }
]
let hubRang = false
const hubEvents = () => (hubRang ? { total: 2 + hubFacts.length, events: doneEvents.events.concat(hubFacts) } : doneEvents)
const caps = { ok: true, source: 'fixture', installed: [{ id: 'milpa/agent', provides: 'sesiones' }, { id: 'milpa/auth', provides: 'identidad' }], available: [{ id: 'milpa/devtools', unlocks: 'make' }] }
// The hosted REMOTE data-table: its signed state (a nonce) advances on every round-trip, and the whole
// wrap re-renders (the remote runtime swaps its outerHTML). tableWrap(nonce) is that render.
let liveNonce = 1000
const stateScript = (n) => '<script type="application/milpa+xhtml" data-milpa-state="pipeline-table"><milpa-state component-id="pipeline-table" component="data-table" security="signed" sig-alg="hmac-sha256" sig-nonce="ac' + n + '"></milpa-state></script>'
const tableWrap = (n) => [
  '<div class="mui-table-wrap" data-milpa-component-id="pipeline-table" x-data="milpaDataTable({&quot;componentId&quot;:&quot;pipeline-table&quot;,&quot;name&quot;:&quot;pipeline_rows&quot;,&quot;initialState&quot;:{&quot;selectedRows&quot;:[],&quot;sortBy&quot;:&quot;&quot;,&quot;sortDirection&quot;:&quot;asc&quot;,&quot;page&quot;:1,&quot;error&quot;:null}})" x-init="init()">',
  '<table class="mui-table"><thead><tr><th><button type="button" class="mui-table__sort" @click="sort(\'deal\')">Deal</button></th></tr></thead><tbody><tr><td>Acme</td></tr></tbody></table>',
  '</div>',
  stateScript(n)
].join('')
contextBridge.exposeInMainWorld('milpa', {
  status: async () => ({ model: { name: 'qwen3.8-27b', base: 'http://llama.local:11438' }, version: 'smoke', backend: (++statusCalls > 2), base: 'http://127.0.0.1:8899' }),
  show: async () => (mode === 'verified' ? { ...show, closure: verifiedClosure } : mode === 'unverified' ? { ...show, closure: unverifiedClosure } : { ...show, question }), owner: async () => ({ ok: true, verified: true, owner: 'key:' + FP, scopes: ['agent:read'] }),
  events: async (_s, since) => {
    if (!hubScenario) return (mode === 'parked' ? events : doneEvents)
    // Only a turn's own reads ask for what lies past a cursor; telemetry and the repaint read from 0.
    if (since > 0) eventsCalls++
    const all = hubEvents()
    return { total: all.total, events: all.events.slice(Math.max(0, since || 0)) }
  },
  onHub: (cb) => { hubCb = cb },
  subscribe: async (session) => {
    if (hubScenario !== 'hub' && hubScenario !== 'hubdrop') return { live: false, reason: 'no hub on this backend' }
    const push = (ms, m) => setTimeout(() => hubCb && hubCb(Object.assign({ session }, m)), ms)
    push(300, { update: { kind: 'reasoning', reasoning: { delta: 'Thinking about' } } })
    push(600, { update: { kind: 'reasoning', reasoning: { delta: ' the plugins' } } })
    if (hubScenario === 'hubdrop') { push(900, { closed: true }); setTimeout(() => { hubRang = true }, 900) }
    else setTimeout(() => { hubRang = true; hubCb && hubCb({ session, update: { kind: 'activity', activity: { state: 'tool', detail: 'plugins_list' } } }) }, 2000)
    return { live: true, session }
  },
  unsubscribe: async () => ({ ok: true }),
  hubProbe: () => ({ eventsCalls }),
  hubStart: (scenario) => { hubScenario = scenario; hubRang = false; eventsCalls = 0 }, keys: async () => ({ ok: true, custody: 'software', keys: [{ fingerprint: FP, uid: 'Operator' }] }),
  keygen: async () => ({ ok: true, fingerprint: FP }), signOp: async () => ({ ok: true }), answer: async () => ({ ok: true }),
  api: async () => ({ ok: true }),
  // Parked queries never resolve; completed queries carry the backend verdict beside the model answer.
  drive: async (query) => {
    if (hubScenario) return new Promise(r => setTimeout(() => r({ ok: true, answer: 'There are 4 plugins.', steps: 2, tools: 1, closure: verifiedClosure }), 4000))
    if (typeof query === 'string' && /verified|verificad/i.test(query)) { mode = 'verified'; return { ok: true, answer: 'All checks passed.', steps: 2, tools: 5, closure: verifiedClosure } }
    if (typeof query === 'string' && /listo|termina|done/i.test(query)) { mode = 'unverified'; return { ok: true, answer: '🔧', steps: 2, tools: 5, closure: unverifiedClosure } }
    return new Promise(() => {})
  },
  capabilities: async () => caps, enableCapability: async () => ({ ok: true, unlocked: ['make'] }),
  agentRunning: async () => ({ running: false }),
  // Bridge transport for the hosted REMOTE component: this fixture stands in for the container's
  // LiveEndpoint. On a declared action it re-renders the data-table with a FRESH signed state (a new
  // nonce) — exactly the { status, data:{ html, state, data } } shape window.MilpaLive.transport wants.
  // (It fakes the signature; the real re-sign + tamper-reject is proven against a real endpoint in a
  // browser — greenhouse evidence/0409.)
  live: async (_endpoint, body) => {
    liveNonce += 1
    return { status: 200, data: { html: tableWrap(liveNonce), state: '<milpa-state sig-nonce="ac' + liveNonce + '"></milpa-state>', data: { sortBy: (body && body.action === 'sort') ? 'deal' : '' } } }
  },
  // A REMOTE-wired Milpa live web component, as the container's /component route would render it: a
  // milpa-live-boot the remote runtime reads, the signed <script data-milpa-state> it echoes, a metric
  // card, and a data-table whose @click="sort('deal')" drives the remote loop over the bridge.
  component: async () => ({ ok: true, html: [
    '<script id="milpa-live-boot" type="application/json">{"endpoint":"/live","sessionId":"live-smoke-1","csrfToken":"tok-smoke"}</script>',
    '<div class="mui-metric-card"><span class="dv-note">context tokens</span><strong class="mui-metric-card__value">6.8k</strong></div>',
    tableWrap(liveNonce)
  ].join('') })
})
try { localStorage.setItem('milpa.ctxWindow', '8192'); localStorage.setItem('milpa.locale', 'en') } catch {}
