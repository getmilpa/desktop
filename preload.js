// The renderer never holds the credential or shells Docker. This preload exposes a narrow bridge; the
// main process does the privileged work (drive the agent in the container, fetch its API with the Bearer).
const { contextBridge, ipcRenderer } = require('electron')

contextBridge.exposeInMainWorld('milpa', {
  // read the container's HTTP API (Bearer injected by the main process' webRequest hook)
  api: (path) => ipcRenderer.invoke('milpa:api', path),
  // drive the agent loop: run `coa agent <query>` in the container against the configured model
  drive: (query, session) => ipcRenderer.invoke('milpa:drive', { query, session }),
  // answer a decision gate (agent:answer) for a session
  answer: (session, decision) => ipcRenderer.invoke('milpa:answer', { session, decision }),
  // runtime facts for the status bar (model, version, backend health)
  show: (session) => ipcRenderer.invoke('milpa:show', session),
  owner: (session) => ipcRenderer.invoke('milpa:owner', session),
  keys: () => ipcRenderer.invoke('milpa:keys'),
  keygen: (name, email) => ipcRenderer.invoke('milpa:keygen', { name, email }),
  signOp: (op, args) => ipcRenderer.invoke('milpa:signOp', { op, args }),
  capabilities: () => ipcRenderer.invoke('milpa:capabilities'),
  skills: () => ipcRenderer.invoke('milpa:skills'),
  roles: () => ipcRenderer.invoke('milpa:roles'),
  declareRole: (input) => ipcRenderer.invoke('milpa:declareRole', input),
  enableCapability: (capability) => ipcRenderer.invoke('milpa:enableCapability', capability),
  events: (session, since) => ipcRenderer.invoke('milpa:events', { session, since }),
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
