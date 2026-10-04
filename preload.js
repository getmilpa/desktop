// The renderer never holds the credential or shells Docker. This preload exposes a narrow bridge; the
// main process does the privileged work (drive the agent in the container, fetch its API with the Bearer).
const { contextBridge, ipcRenderer } = require('electron')

// Only the Desktop's own pages get the bridge. The same window later shows the house's panel over http — a page that
// also shows what a resident built — and that page gets nothing here (main refuses its calls too; evidence/1091, E3).
if (location.protocol === 'file:') contextBridge.exposeInMainWorld('milpa', {
  // the boot screen: where the house is and whether it serves its panel yet; open a link of THIS house in the window,
  // or in the person's browser — which can ask for a security key's PIN (greenhouse decisions/0566)
  boot: () => ipcRenderer.invoke('milpa:boot'),
  openInWindow: (url) => ipcRenderer.invoke('milpa:openInWindow', url),
  openInBrowser: (url) => ipcRenderer.invoke('milpa:openInBrowser', url),
  // read the container's HTTP API (Bearer injected by the main process' webRequest hook)
  api: (path) => ipcRenderer.invoke('milpa:api', path),
  // drive the agent loop: run `coa agent <query>` in the container against the configured model
  drive: (query, session, mode) => ipcRenderer.invoke('milpa:drive', { query, session, mode }),
  // answer a decision gate (agent:answer) for a session
  answer: (session, decision) => ipcRenderer.invoke('milpa:answer', { session, decision }),
  // runtime facts for the status bar (model, version, backend health)
  show: (session) => ipcRenderer.invoke('milpa:show', session),
  owner: (session) => ipcRenderer.invoke('milpa:owner', session),
  keys: () => ipcRenderer.invoke('milpa:keys'),
  keygen: (name, email) => ipcRenderer.invoke('milpa:keygen', { name, email }),
  // Open the passkey ceremony in its own http://localhost window (WebAuthn needs a real origin, not
  // the file:// renderer). `enroll` registers this device; `approve` shows the exact operation and
  // authorizes it with a touch (greenhouse decisions/0187, D-01 browser ceremony).
  passkey: {
    enroll: () => ipcRenderer.invoke('milpa:passkey', { kind: 'enroll' }),
    approve: (session, operation, args) => ipcRenderer.invoke('milpa:passkey', { kind: 'intent', session, operation, args }),
  },
  signOp: (op, args) => ipcRenderer.invoke('milpa:signOp', { op, args }),
  capabilities: () => ipcRenderer.invoke('milpa:capabilities'),
  skills: () => ipcRenderer.invoke('milpa:skills'),
  roles: () => ipcRenderer.invoke('milpa:roles'),
  catalogue: () => ipcRenderer.invoke('milpa:catalogue'),
  declareRole: (input) => ipcRenderer.invoke('milpa:declareRole', input),
  enableCapability: (capability) => ipcRenderer.invoke('milpa:enableCapability', capability),
  events: (session, since) => ipcRenderer.invoke('milpa:events', { session, since }),
  // The hub (greenhouse decisions/0508): subscribe to ONE session's pushed updates. `{ live: false }` means this
  // backend has no hub and the renderer polls `events`; with one, each update arrives through `onHub`.
  subscribe: (session) => ipcRenderer.invoke('milpa:subscribe', { session }),
  unsubscribe: () => ipcRenderer.invoke('milpa:unsubscribe'),
  onHub: (cb) => { ipcRenderer.on('milpa:hub', (_e, m) => cb(m)) },
  // whether a driving agent run is live in the container — the renderer flags an INTERRUPTED prior run with this
  agentRunning: () => ipcRenderer.invoke('milpa:agentRunning'),
  stopAgent: () => ipcRenderer.invoke('milpa:stopAgent'),
  // host a Milpa live web component rendered by the container (a Desktop screen authored the Milpa way)
  component: (name) => ipcRenderer.invoke('milpa:component', name),
  // The bridge transport for hosted live components: the remote runtime's POST routed through IPC to
  // the container (the renderer is file://, so it cannot fetch the backend directly).
  live: (endpoint, body) => ipcRenderer.invoke('milpa:live', { endpoint, body }),
  status: () => ipcRenderer.invoke('milpa:status'),
  // Save an audit export of the session to a file the human picks (a Save dialog in the main process).
  saveExport: (name, content) => ipcRenderer.invoke('milpa:saveExport', { name, content }),
})
