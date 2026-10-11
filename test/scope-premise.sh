#!/usr/bin/env sh
# THE PREMISE the boot screen's workspace step teaches (t-0092), measured BY EXECUTION in a lab house.
#
# The boot screen guides enabling `milpa/agent-workspace` so the one-time link it prints lets the person drive the
# agent. This proves the premise: enabling the PANEL (milpa/admin) alone does NOT put `agent:run` in the first human's
# scope, but enabling the WORKSPACE (milpa/agent-workspace) DOES — so a person who enrolls with the workspace's link
# can write to a session, and with only the panel's link cannot (MILPA_SCOPE_DENIED agent:run). If this fails, the
# boot-screen instruction is wrong and must not ship.
#
# Lab only: an ed25519 lab key with disable-scdaemon in a throwaway keyring, rooted out of band in config/identity.php;
# NEVER Rod's keyring, pcscd, card, or ~/.milpa. It NEEDS network (capabilities:enable runs `composer require`).
#   usage: sh test/scope-premise.sh [image]   (default: ghcr.io/getmilpa/framework:dev — the PUBLISHED image)
set -e
IMG="${1:-ghcr.io/getmilpa/framework:dev}"
NAME=milpa-scope-premise
WK="$(mktemp -d /tmp/scope-premise.XXXX)"
cleanup () { docker rm -f "$NAME" >/dev/null 2>&1 || true; [ -n "$WK" ] && [ -d "$WK" ] && rm -rf "$WK"; }
trap cleanup EXIT

HK="$WK/gnupg"; mkdir -p "$HK/config"; chmod 700 "$HK"
printf 'disable-scdaemon\n' > "$HK/gpg-agent.conf"
printf '%%no-protection\nKey-Type: eddsa\nKey-Curve: ed25519\nKey-Usage: sign\nName-Real: Lab\nName-Email: lab@lab.local\nExpire-Date: 0\n%%commit\n' \
  | GNUPGHOME="$HK" gpg --batch --pinentry-mode loopback --gen-key 2>/dev/null
FPR="$(GNUPGHOME="$HK" gpg --list-secret-keys --with-colons | awk -F: '/^fpr/{print $10;exit}')"
printf 'default-key %s\nbatch\npinentry-mode loopback\n' "$FPR" >> "$HK/gpg.conf"
printf "<?php\n\nreturn ['rooted' => ['%s']];\n" "$FPR" > "$WK/config-identity.php"

docker rm -f "$NAME" >/dev/null 2>&1 || true
# a local keyring (lab) + the out-of-band root; no sign socket, so the house signs with its local GnupgOperationSigner
docker run -d --name "$NAME" -v "$HK:/root/.gnupg" -v "$WK/config-identity.php:/app/config/identity.php:ro" \
  --entrypoint sleep "$IMG" infinity >/dev/null

scopes () { docker exec "$NAME" php -r 'require "vendor/autoload.php"; echo implode(" ", \Milpa\AppRuntime\Identity\FirstHuman::scopes());' 2>/dev/null; }
has_run () { echo " $1 " | grep -q ' agent:run '; }

docker exec "$NAME" php bin/coa foundation:found --domain="lab house" --objective="measure the premise" --sign --json >/dev/null 2>&1
S0="$(scopes)"
docker exec "$NAME" php bin/coa capabilities:enable milpa/admin --sign --json >/dev/null 2>&1
S1="$(scopes)"
docker exec "$NAME" php bin/coa capabilities:enable milpa/agent-workspace --sign --json >/dev/null 2>&1
S2="$(scopes)"

echo "# image=$IMG"
echo "scope after found:                      [$S0]"
echo "scope after enable milpa/admin:         [$S1]"
echo "scope after enable milpa/agent-workspace:[$S2]"

status=0
if has_run "$S1"; then echo "FAIL · the panel alone already carries agent:run (premise is moot)"; status=1
else echo "OK · the panel (milpa/admin) link does NOT carry agent:run"; fi
if has_run "$S2"; then echo "OK · enabling the workspace (milpa/agent-workspace) adds agent:run — the boot-screen instruction is sound"
else echo "FAIL · the workspace does NOT bring agent:run — the boot-screen instruction must not ship"; status=1; fi
exit $status
