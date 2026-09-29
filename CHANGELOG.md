# Changelog

All notable changes to Milpa Desktop are documented here. This project adheres to
[Semantic Versioning](https://semver.org/) and [Keep a Changelog](https://keepachangelog.com/).

## [Unreleased]

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
