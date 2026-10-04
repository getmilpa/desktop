# Changelog

All notable changes to Milpa Desktop are documented here. This project adheres to
[Semantic Versioning](https://semver.org/) and [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

### Fixed
- A security key that asks for a PIN can register and sign in: the boot screen opens the one-time link and the panel **in your browser** (first button), or in the window (second). Electron ships Chromium's WebAuthn without a PIN dialog, so in the window a ceremony that requires user verification — every one of the house's — answered «The key did not answer: The operation either timed out or was not allowed» to a YubiKey 5 (greenhouse decisions/0566, evidence/1100). Where the panel was last opened is remembered; a launch opens it in the window by itself only after a sign-in finished there. The right-click menu on a page of the house offers «Open in your browser». New `milpa:openInBrowser` IPC, held to links of this house like `milpa:openInWindow`.
- The boot screen no longer prints `foundation:found --domain="…" --objective="…" --sign`, a command that founded a house with «…» when copied as it stood. It asks what the house is for and what founding it should achieve, and composes the command — quoted for a shell — only when both fields say something.

## [0.5.1] - 2026-10-03

### Added
- The window reloads: Ctrl/Cmd+R, F5, Ctrl+Shift+R, Alt+←/→, and a right-click menu with Back / Forward / Reload. The Desktop's bridge stays out of the panel (greenhouse decisions/0563).

## [0.5.0] - 2026-10-03

### Fixed
- Passkeys on houses with milpa/auth ≥ 0.11 (app-runtime ≥ 0.201): the house only admits ceremonies from the origins it knows, and the Desktop's port (8899, or `MILPA_PORT`) was none of them — `http://localhost:8000` is what a house declares or derives — so the passkey window's registration and sign-in answered 401 (greenhouse evidence/1068). The container now starts with `MILPA_PASSKEY_ORIGINS=http://localhost:<port>`, the origin the passkey window opens at; the house adds it to its own from the app-runtime release that carries getmilpa/app-runtime#663 (greenhouse decisions/0534); older runtimes ignore the variable, so on them the window is still refused.

### Added
- The hub instead of the poll (greenhouse decisions/0508): by default the shell runs `ghcr.io/getmilpa/framework:dev-frankenphp` — the same app served by FrankenPHP classic, with its Mercure hub on the app's own port — keeping the image's own entrypoint, and subscribes to the driven session's topic (`milpa/sessions/<id>`). The model's reasoning streams into the bubble while it is being written; every other update rings one read of the session stream, which stays the truth. The subscriber JWT is signed inside the container for that one topic, so the key never leaves it. New `milpa:subscribe` / `milpa:unsubscribe` IPC and `window.milpa.subscribe` / `onHub`. `milpa:status` reports `image`, `server` and `hub`.
- Fallback floor: when the variant cannot be had, the plain `ghcr.io/getmilpa/framework:dev` runs under `php -S` with `PHP_CLI_SERVER_WORKERS=8`, and the renderer polls as before; if the hub drops mid-turn, main retries three times and the renderer falls back to polling. Which server runs is read from the image (its entrypoint), not from its tag; the hub is probed by what it answers, not assumed.

### Changed
- `run-desktop.sh` no longer pins `MILPA_IMAGE` to `:dev`: unset, it pre-pulls the FrankenPHP variant and falls back to `:dev`, the same order main.js follows.
- Passkey ceremony wiring (greenhouse decisions/0187, D-01): the decision gate now offers **Approve with passkey** and **Register passkey**. Because WebAuthn refuses the `file://` renderer (and an IP is not a valid relying-party id), these open a dedicated `http://localhost` window served by the container (`/webauthn/intent` showing the exact operation, `/webauthn/enroll`), so `navigator.credentials.*` runs at a real origin with rpId `localhost`. New `milpa:passkey` IPC handler + `window.milpa.passkey.{enroll,approve}` bridge. Requires the container app to serve the passkey pages (`milpa/app-runtime ≥ 0.111` + `passkey.rpId` in config). The resume that clears the agent's gate from the ceremony is the remaining backend step.

## [0.2.1]

### Fixed
- Components pane: the `Screen` / `Preview` labels no longer render as raw i18n keys (missing catalog entries, en + es).
- Decisions pane: the session-decisions list showed `[object Object]`; it now renders each decision's question with its answer as a badge, reading the real backend fields (`question`, `answer`, `expired`).


### Added
- Live preview pane: type the name of a screen the agent declared (`screen:declare`) and see it rendered.
- Cross-platform launcher (`run-desktop.sh`) that pulls the public image and seeds demo screens.
- Checksummed build (`build-desktop.sh`) and a CI workflow that builds Linux + macOS distributables with
  `SHA256SUMS.txt` on a `desktop-v*` tag.
- i18n (English default, Spanish selectable).

_Extracted into its own public home as a client of the framework._
