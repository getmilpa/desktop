# Security Policy

## Supported Versions

Milpa Desktop is pre-1.0. Only the latest `0.x` release line receives security fixes.

The Desktop is a thin Electron shell over a Milpa app that runs in a Docker container. The framework
itself arrives inside the public image (`ghcr.io/getmilpa/framework:dev`); its own advisories land in
the `milpa/*` packages. Fixes here cover the shell — the main process that owns the container lifecycle,
the Bearer credential, and key custody — not the framework running inside the container.

## Reporting a Vulnerability

Please report security vulnerabilities **privately** via GitHub Security Advisories
— the repository's **Security** tab → **Report a vulnerability** — rather than opening
a public issue or pull request.

We aim to acknowledge a report within 72 hours and to keep you informed as we work
on a fix. Once a fix is released, we will credit the reporter unless anonymity is
requested.

---

Milpa is developed and maintained by [TeamX Agency](https://teamx.agency).
