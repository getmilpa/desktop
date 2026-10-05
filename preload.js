// The renderer never holds the credential or shells Docker. This preload exposes a narrow bridge; the
// main process does the privileged work (drive the agent in the container, fetch its API with the Bearer).
const { contextBridge, ipcRenderer } = require('electron')

// Only the Desktop's own pages get the bridge. The same window later shows the house's panel over http — a page that
// also shows what a resident built — and that page gets nothing here (main refuses its calls too; evidence/1091, E3).
if (location.protocol === 'file:') contextBridge.exposeInMainWorld('milpa', {
  // the boot screen: where the house is and whether it serves its panel yet; open a link of THIS house in the window,
  // or in the person's browser (greenhouse decisions/0566)
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

// THE HOUSE'S PAGES GET ONE THING: WEBAUTHN, WITH A CLIENT THAT CAN ASK FOR A PIN (greenhouse decisions/0568).
// Chromium in Electron cannot ask for a security key's PIN, so a key that verifies its user by PIN could not register
// or sign in in this window (evidence/1100). On a page of the house — the origin main names, top frame only —
// `navigator.credentials.create` and `.get` ask main first: when a plugged-in key needs its PIN asked, the Desktop
// runs the ceremony and asks for the PIN in a window of its own; otherwise main says so and the call goes to
// Chromium untouched, as it always did. The page hands in what it would hand a browser and gets back what a browser
// returns. It gets no `window.milpa`, no docker, no gpg, and never the PIN. main checks who is asking again
// (security-key/desk.js); this check only keeps the two functions off pages that would be refused anyway.
const HOUSE = (process.argv.find(a => a.startsWith('--milpa-house=')) || '').slice('--milpa-house='.length)
if (HOUSE !== '' && location.origin === HOUSE && window.top === window) {
  const ask = (kind, publicKey) => ipcRenderer.invoke('milpa:webauthn', { kind, publicKey }).catch(() => ({ error: { name: 'NotAllowedError' } }))
  // What follows runs in the page's world, and is everything the page is given. `ask` stays inside it.
  contextBridge.executeInMainWorld({
    func: (ask) => {
      const container = navigator.credentials
      const chromium = { create: container.create.bind(container), get: container.get.bind(container) }
      const b64u = (b) => { const u = b instanceof ArrayBuffer ? new Uint8Array(b) : new Uint8Array(b.buffer, b.byteOffset, b.byteLength); let s = ''; for (const x of u) s += String.fromCharCode(x); return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '') }
      const buf = (s) => Uint8Array.from(atob(String(s).replace(/-/g, '+').replace(/_/g, '/')), c => c.charCodeAt(0)).buffer
      // The request as main reads it: the same fields, every byte string in base64url.
      const listed = (l) => (Array.isArray(l) ? l.map(c => ({ type: c.type, id: b64u(c.id) })) : undefined)
      const scalars = (o, names) => { const out = {}; if (o) for (const n of names) if (typeof o[n] === 'string' || typeof o[n] === 'number' || typeof o[n] === 'boolean') out[n] = o[n]; return out }
      const wire = (pk) => ({
        ...scalars(pk, ['rpId', 'timeout', 'attestation', 'userVerification']),
        rp: pk.rp ? scalars(pk.rp, ['id', 'name']) : undefined,
        user: pk.user ? { ...scalars(pk.user, ['name', 'displayName']), id: b64u(pk.user.id) } : undefined,
        challenge: b64u(pk.challenge),
        pubKeyCredParams: Array.isArray(pk.pubKeyCredParams) ? pk.pubKeyCredParams.map(p => scalars(p, ['type', 'alg'])) : undefined,
        authenticatorSelection: pk.authenticatorSelection ? scalars(pk.authenticatorSelection, ['userVerification', 'residentKey', 'requireResidentKey', 'authenticatorAttachment']) : undefined,
        excludeCredentials: listed(pk.excludeCredentials), allowCredentials: listed(pk.allowCredentials),
      })
      // The key's answer as a page reads a PublicKeyCredential: byte strings as ArrayBuffers, and its methods.
      const credential = (c) => {
        const r = c.response; const made = typeof r.attestationObject === 'string'
        const response = made
          ? { clientDataJSON: buf(r.clientDataJSON), attestationObject: buf(r.attestationObject), getAuthenticatorData: () => buf(r.authenticatorData), getPublicKey: () => (r.publicKey ? buf(r.publicKey) : null), getPublicKeyAlgorithm: () => r.publicKeyAlgorithm, getTransports: () => (r.transports || []).slice() }
          : { clientDataJSON: buf(r.clientDataJSON), authenticatorData: buf(r.authenticatorData), signature: buf(r.signature), userHandle: r.userHandle ? buf(r.userHandle) : null }
        const json = made
          ? { clientDataJSON: r.clientDataJSON, attestationObject: r.attestationObject, authenticatorData: r.authenticatorData, publicKey: r.publicKey || undefined, publicKeyAlgorithm: r.publicKeyAlgorithm, transports: r.transports || [] }
          : { clientDataJSON: r.clientDataJSON, authenticatorData: r.authenticatorData, signature: r.signature, userHandle: r.userHandle || undefined }
        return {
          id: c.id, rawId: buf(c.rawId), type: 'public-key', authenticatorAttachment: c.authenticatorAttachment || null, response,
          getClientExtensionResults: () => ({}),
          toJSON: () => ({ id: c.id, rawId: c.rawId, type: 'public-key', authenticatorAttachment: c.authenticatorAttachment || undefined, response: json, clientExtensionResults: {} }),
        }
      }
      const through = (kind) => function (options) {
        const publicKey = options && options.publicKey
        // Anything that is not a plain public-key request — a password, an autofill offer, nothing — is Chromium's.
        if (!publicKey || typeof publicKey !== 'object' || options.mediation === 'conditional') return chromium[kind](options)
        return (async () => {
          let request = null
          try { request = wire(publicKey) } catch {}
          if (request === null) return chromium[kind](options)   // malformed: Chromium says how, in its own words
          const answer = await ask(kind, request)
          if (answer && answer.native === true) return chromium[kind](options)
          if (answer && answer.credential) return credential(answer.credential)
          const refused = (answer && answer.error) || {}
          const message = refused.message || 'The operation either timed out or was not allowed.'
          throw refused.name === 'TypeError' ? new TypeError(message) : new DOMException(message, refused.name || 'NotAllowedError')
        })()
      }
      // THE HOUSE'S CEREMONY PAGE WARNS WHEN THESE ARE NOT NATIVE CODE — how it catches a browser extension that
      // swallowed a ceremony (greenhouse evidence/0519). Here it is the client itself that answers, and the warning
      // would be false, on screen, beside the Desktop's own PIN window. A bound function reads as native code, so
      // these are bound; decisions/0568 names this for what it is and leaves the other way to Rod.
      const define = (name, value) => Object.defineProperty(CredentialsContainer.prototype, name, { value, writable: true, enumerable: true, configurable: true })
      define('create', through('create').bind(container)); define('get', through('get').bind(container))
    },
    args: [ask],
  })
}
