# Vendored client runtime (Milpa live, web surface)

The Desktop hosts Milpa live web components (the `<milpa-state>` + Alpine `x-data` markup a
component's server side emits). To make a hosted component **reactive** in the shell, the renderer
loads the same client runtime a real Milpa web page would:

- `milpa-live.js` — the LOCAL client runtime, vendored from **`milpa/live-web`** (`resources/milpa-live.js`),
  now the single owner of the local Alpine factories the renderers emit: `milpaField`, `milpaCheckbox`,
  `milpaDataTable`, registered via `Alpine.data` (greenhouse decisions/0145 — live-web absorbed the
  richer factory set the components-lab had grown, so a page never ships its own copy). It makes no
  network request; `milpaAutocomplete` fetches and therefore lives in the REMOTE runtime, not here.
- `milpa-live-remote.js` — the REMOTE client runtime (vendored from `milpa/live-web`): it takes a
  hosted component's declared actions (sort, search, select…) to the backend's LiveEndpoint and
  applies the answer. It backs the over-the-wire `milpaDataTable` and `milpaAutocomplete`, which
  OVERRIDE the local factories when this file is present — so a hosted component becomes *remote*.
- `vendor/alpine.min.js` — Alpine 3, vendored verbatim from `milpa/live-web`
  (`resources/vendor/alpine.min.js`). No-build (ADR#10): served as-is, loaded AFTER the runtimes so
  the factory globals exist before Alpine walks the DOM.

Load order (index.html): `live/milpa-live.js`, then `live/milpa-live-remote.js`, then
`live/vendor/alpine.min.js` — all `defer`. Late-injected component subtrees (hosted via IPC after
Alpine already booted) are hydrated explicitly with `window.Alpine.initTree(host)` — see
`renderer/app.js` `renderComponents()`.

**The bridge transport (greenhouse decisions/0148).** The renderer is `file://`, so the remote
runtime cannot fetch the container directly. `app.js` `ensureLiveTransport()` sets
`window.MilpaLive.transport` to route the POST through `window.milpa.live(endpoint, body)` → IPC
(`main.js` `milpa:live`) → the container's live endpoint. That is what makes a hosted component's
action round-trip in a native shell instead of a cross-origin fetch.

(c) Rodrigo Vicente - TeamX Agency — Apache-2.0
