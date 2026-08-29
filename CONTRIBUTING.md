# Contributing to Milpa Desktop

Thanks for helping improve the Milpa Desktop — the Electron shell that hosts a Milpa app and previews
the UI the agent declares.

## What this repo is

A native desktop **client** of the Milpa framework. The window is Electron; the backend is a real Milpa
app in a Docker container, pulled from the public image. The framework lives in the `milpa/*` packages
(and the [framework](https://github.com/getmilpa/framework) repo) — changes to the runtime belong there,
not here. This repo owns the shell: the main process, the renderer, the bridge between them.

## Run it locally

Prerequisites: **Node.js**, **Docker** running, and (for the agent conversation only) an
OpenAI-compatible model endpoint.

```bash
npm install              # pulls Electron + electron-builder
sh run-desktop.sh        # pulls the public image if missing, launches the shell, seeds demo screens
npm run verify           # renderer checks against fixtures (no model, no container needed)
```

## Before opening a PR

- `npm run verify` passes (the renderer smoke checks).
- The shell launches and the preview pane renders a declared screen (`tasks`, `salud`, `flujo`, `panel`).
- Keep the trust boundary intact: the **main process** owns the container, the Bearer credential, the
  agent driver, and key custody; the **renderer** only projects. Never move a secret across the bridge.

## Building distributables

```bash
sh build-desktop.sh   # this platform + a dist/SHA256SUMS.txt
```

CI (`.github/workflows/desktop-release.yml`) builds Linux + macOS with checksums on a `desktop-v*` tag and
publishes a Release. electron-builder cannot cross-compile to macOS from Linux — build each on its own OS.

---

Milpa is developed and maintained by [TeamX Agency](https://teamx.agency).
