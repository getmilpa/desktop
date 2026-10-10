#!/usr/bin/env sh
# Run the Milpa Desktop smoke tests with the resolved Electron binary — under xvfb on a headless Linux box: the
# workspace renderer (smoke.js), then the boot screen the window shows while the house comes up (smoke-boot.js),
# then the window's own keys and menu on a web page (smoke-window.js), then a passkey ceremony with a security key
# that asks for a PIN (smoke-key.js). --no-sandbox goes on the command line: appended
# from the script it arrives after the renderer's sandbox is set up, and an http page then cannot get shared memory.
DIR="$(cd "$(dirname "$0")/.." && pwd)"
ELECTRON="$(node -p 'require("electron")')"
status=0

# ── GUARDS (greenhouse decisions/0611 review) ───────────────────────────────────────────────────────────────────
# A security patch must not ship a switch that weakens approval, nor fall back to the OLD keyring that was mounted into
# the container. These check the SOURCE, not behaviour. Each carries a mutation self-test (a known-bad line MUST be
# caught) and treats a scan error as a failure, never a silent pass. Production files: main.js + the signer modules,
# preloads and renderer. A match (the bad pattern is present) FAILS; clean passes; a grep error FAILS.
SEAM_RE='process\.env\.(MILPA_SIGN_AUTODECIDE|MILPA_SIGN_TEST_ALLOW_ANY_SENDER|MILPA_SIGN_WINDOW_MS|MILPA_SIGN_SHOT)'
OLDKEY_RE="\\bMILPA_GNUPGHOME\\b|'\\.milpa',[[:space:]]*'gnupg'|\\.milpa/gnupg"
guard () { # $1=label $2=forbidden-pattern $3..=files
  _label="$1"; _pat="$2"; shift 2
  _out="$(grep -nHE "$_pat" "$@" 2>&1)"; _rc=$?
  if   [ "$_rc" -eq 1 ]; then echo "OK · $_label"
  elif [ "$_rc" -eq 0 ]; then echo "FAIL · $_label"; echo "$_out" | sed 's/^/    /'; status=1
  else echo "FAIL · $_label — guard could not scan (grep rc=$_rc): $_out"; status=1; fi
}
# mutation self-tests: the patterns MUST catch a reintroduced seam / old-keyring reference, or the guards are broken
printf 'x = process.env.MILPA_SIGN_AUTODECIDE\n' | grep -qE "$SEAM_RE"  || { echo "FAIL · seam guard pattern is broken (self-test)"; status=1; }
printf 'x = process.env.MILPA_GNUPGHOME\n'       | grep -qE "$OLDKEY_RE" || { echo "FAIL · old-keyring guard pattern is broken (self-test)"; status=1; }
guard "no production file reads the approval test seams (0611: pass them as makeApprover options, which only the smoke does)" \
  "$SEAM_RE" "$DIR/main.js" "$DIR/host-approve.js" "$DIR/host-signer.js" "$DIR/sign-wiring.js" "$DIR/preload.js" "$DIR/sign-approval-preload.js" "$DIR/renderer/sign-approval.js"
guard "no production file references the OLD mounted keyring (0611: the signer uses the NEW ~/.milpa/host-gnupg)" \
  "$OLDKEY_RE" "$DIR/main.js" "$DIR/host-approve.js" "$DIR/host-signer.js" "$DIR/sign-wiring.js" "$DIR/preload.js" "$DIR/sign-approval-preload.js" "$DIR/renderer/sign-approval.js"

# Which image a launch runs when nobody names one — plain node, a fake docker (greenhouse evidence/1095, G1).
node "$DIR/test/choose-image.js" || status=1
# Where the house's pages open — this window or the browser — and that every module main.js loads is packaged.
node "$DIR/test/open-where.js" || status=1
# A security key that asks for a PIN: the PIN's math against Yubico's, the wire, the ceremony — against a key that
# is a process, never a real one (greenhouse decisions/0568).
node "$DIR/test/security-key.js" || status=1
for SMOKE in "$DIR/test/smoke.js" "$DIR/test/smoke-boot.js" "$DIR/test/smoke-window.js" "$DIR/test/smoke-key.js"; do
  if [ "$(uname)" = "Linux" ] && [ -z "$DISPLAY" ]; then
    xvfb-run -a --server-args='-screen 0 1320x840x24' "$ELECTRON" --no-sandbox "$SMOKE" || status=1
  else
    "$ELECTRON" --no-sandbox "$SMOKE" || status=1
  fi
done
# The host signer (greenhouse decisions/0611): the person's key signs on the host, the container only verifies. Unlike
# the other smokes (which fake docker), this one needs a REAL container, so it runs only where Docker and the framework
# image are present — skipped cleanly otherwise. It uses lab keys (ed25519, disable-scdaemon) in throwaway keyrings and
# a --network none container; it never touches a real keyring, pcscd, or card. MILPA_APP_RUNTIME_SRC overlays a local
# app-runtime (needed only until the image ships #789's RemoteOperationSigner).
SIGN_IMG="${MILPA_LAB_IMAGE:-ghcr.io/getmilpa/framework:dev}"
if command -v docker >/dev/null 2>&1 && docker image inspect "$SIGN_IMG" >/dev/null 2>&1; then
  if [ "$(uname)" = "Linux" ] && [ -z "$DISPLAY" ]; then
    xvfb-run -a --server-args='-screen 0 1320x840x24' "$ELECTRON" --no-sandbox "$DIR/test/smoke-sign.js" || status=1
  else
    "$ELECTRON" --no-sandbox "$DIR/test/smoke-sign.js" || status=1
  fi
else
  echo "SKIP · host signer measure (greenhouse decisions/0611) — needs Docker and the framework image ($SIGN_IMG)"
fi
exit $status
