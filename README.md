<p align="center">
  <a href="https://github.com/getmilpa">
    <picture>
      <source media="(prefers-color-scheme: dark)" srcset="https://raw.githubusercontent.com/getmilpa/core/main/art/lockup/milpa-lockup-v-color-dark.svg">
      <img src="https://raw.githubusercontent.com/getmilpa/core/main/art/lockup/milpa-lockup-v-color-light.svg" alt="Milpa" width="300">
    </picture>
  </a>
</p>

# milpa/desktop

A native desktop shell for the [Milpa](https://github.com/getmilpa) agent. The backend is a real Milpa app running
in a Docker container, and the window is that house's own panel: a local boot screen while the house comes up, then
the panel at the origin the Desktop declared to it, where you sign in with your passkey. The Electron **main process**
owns the container's lifecycle, driving the agent and identity/key custody; it holds no credential of its own.

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
the backend image. By default the shell runs `ghcr.io/getmilpa/framework:dev-frankenphp` — the same app served by
FrankenPHP, with a Mercure hub on the app's own port — and subscribes to it, so the agent's work and the model's
reasoning stream in as they happen. When that image cannot be had it falls back to `ghcr.io/getmilpa/framework:dev`,
served by `php -S` with several workers, and the UI polls the session instead.

## Architecture

- **main.js** — the trusted process. Starts and stops the backend container, shows the boot screen
  (`renderer/boot.html`) and then the house's panel in the same window, drives the agent, and holds the signing key
  custody. It holds no Bearer: the house refuses an unsigned `token:new` (greenhouse decisions/0522), and the person's
  passkey sign-in is what the house judges (evidence/1091). It declares two facts to the house it serves: the origin a
  passkey sees (`MILPA_PASSKEY_ORIGINS`) and how a person reaches its terminal (`MILPA_CLI_PREFIX`), so the commands
  the house prints run as printed. The bridge is exposed only to the Desktop's own `file://` pages, never to the panel.
- **preload.js** — the narrow bridge: `milpa:component` (fetch a rendered component) and `milpa:live` (the
  live wire). Nothing else crosses.
- **window-chrome.js** — the window's own keys and menu, since it shows a web page and has no native menu: reload
  (`Ctrl/Cmd+R`, `F5`; with `Shift`, past the cache), back and forward (`Alt+←`, `Alt+→`), devtools
  (`Ctrl/Cmd+Shift+I`), and a right-click menu that offers Back, Forward and Reload by name. It hands the page nothing.
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
