# Milpa Desktop — the distributable

A downloadable Milpa Desktop: **no repo clone, no `npm install`.** You download one file and run it. It talks
to the **public** dev image (`ghcr.io/getmilpa/framework:dev`, pulled on first launch) — the framework arrives
inside the container, not as code you clone.

## What a user needs

- **Docker** installed and running. That's the one real prerequisite — the binary removes the clone + npm
  friction, not Docker (the Desktop orchestrates a container).
- **For the agent conversation only:** an OpenAI-compatible model endpoint. The board and the **live preview
  pane render without any model** — declared screens (`screen:declare`) are served by the container. Only the
  agent chat needs a model.

## Run it

- **Linux:** download `Milpa-Desktop-*.AppImage`, then:
  ```bash
  chmod +x Milpa-Desktop-*.AppImage
  ./Milpa-Desktop-*.AppImage
  ```
- **macOS:** download the `.dmg`, open it, drag Milpa Desktop to Applications, launch it.

First launch pulls `ghcr.io/getmilpa/framework:dev` (public, no auth). Then: **Components → type a screen name
(`tasks`, `data-table`, …) → Preview** to see a component the Milpa way, live.

### Pointing the agent at a model

The agent defaults to `http://llama.local:11438` (the house's local model — not yours). Set your own before
launching:

```bash
MILPA_AGENT_BASE_URL=http://127.0.0.1:11434 MILPA_AGENT_MODEL=your-model ./Milpa-Desktop-*.AppImage
```

(or the endpoint field in the Desktop's **Settings** pane). Any OpenAI-compatible `/v1/chat/completions` that
returns real `tool_calls` works.

## Build it yourself (maintainers)

From the repo root after `npm install`:

```bash
npm run dist       # Linux  → dist/Milpa-Desktop-*.AppImage
npm run dist:mac   # macOS  → dist/*.dmg + *.zip   (must run ON a Mac)
```

The Linux AppImage builds on Linux; the macOS artifacts must be built on macOS (or CI). Both bundle the shell
(`main.js` + `renderer/`) and default to the public image, so the output is self-contained beyond Docker.

## The graduated vocabulary

The preview pane shows whatever the pulled image serves. The full authored-UI vocabulary (metric-card,
state-machine, autocomplete, composites, coordinated layouts) ships when the public image
(`ghcr.io/getmilpa/framework:dev`) is (re)built with `milpa/app-runtime ^0.90` + `milpa/live-web ^0.9`. Until
then the binary previews what the current public image serves (data-table / tasks); when the image is updated,
the same binary gains the rest automatically — no new download.

---
Apache-2.0 · © Rodrigo Vicente - TeamX Agency
