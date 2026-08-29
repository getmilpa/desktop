# Milpa Desktop

A native desktop shell for the [Milpa](https://github.com/getmilpa) agent. The window is an Electron app
rendering a local, `@milpa/design`-styled UI; the backend is a real Milpa app running in a Docker container.
The Electron **main process** owns everything the renderer must never touch — the container's lifecycle, the
Bearer credential, driving the agent, and identity/key custody — and exposes a narrow bridge to the renderer.

Beyond the agent board, the window carries a **live preview pane**: type the name of a screen the agent
declared (`screen:declare`) and see the UI it is building, rendered by the same container that serves it.

## Just want to run it?

You do **not** need to clone this repo. Download a prebuilt binary from the
[Releases](https://github.com/getmilpa/desktop/releases) and follow **[DISTRIBUTION.md](DISTRIBUTION.md)** —
one file, Docker as the only prerequisite. The app pulls the public image
(`ghcr.io/getmilpa/framework:dev`) on first launch.

## Run from source (developers)

Prerequisites: **Node.js**, **Docker** running, and (for the agent conversation) an OpenAI-compatible model
endpoint. The board and preview pane render without any model.

```bash
npm install              # once — pulls Electron + electron-builder
sh run-desktop.sh        # pulls the public image if missing, launches the shell, seeds demo screens
```

Point the agent at your own model before launching:

```bash
MILPA_AGENT_BASE_URL=http://127.0.0.1:11434 MILPA_AGENT_MODEL=your-model sh run-desktop.sh
```

Any OpenAI-compatible `/v1/chat/completions` that returns real `tool_calls` works. `MILPA_IMAGE` overrides
the backend image (default `ghcr.io/getmilpa/framework:dev`).

## Architecture

- **main.js** — the trusted process. Starts and stops the backend container, mints the Bearer token, injects
  it via `session.webRequest.onBeforeSendHeaders`, drives the agent, and holds the signing key custody. The
  renderer is `file://` and never sees the credential.
- **preload.js** — the narrow bridge: `milpa:component` (fetch a rendered component) and `milpa:live` (the
  live wire). Nothing else crosses.
- **renderer/** — the projected UI. Alpine-hydrated components, i18n (en/es, English default), and the live
  preview pane. It *projects* facts (session owner, decisions); it never decides them.

The backend is an **ephemeral container**: the framework arrives inside the image, not as code you clone.
Signing keys live on the host so they outlive the container.

## Build a distributable

```bash
npm run dist        # Linux → dist/Milpa-Desktop-<ver>-<arch>.AppImage
npm run dist:mac    # macOS → dist/*.dmg + *.zip   (must run ON a Mac)
sh build-desktop.sh # this platform + a dist/SHA256SUMS.txt, release-ready
```

electron-builder cannot cross-compile to macOS from Linux — build each platform on its own machine, or push a
`desktop-v*` tag and let CI (`.github/workflows/desktop-release.yml`) build both with checksums and publish a
Release.

## Verify

```bash
npm run verify      # renderer checks against fixtures; screenshots land in test/screenshots/ (gitignored)
```

---
Apache-2.0 · © Rodrigo Vicente - TeamX Agency
