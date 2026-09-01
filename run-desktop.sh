#!/usr/bin/env bash
# Milpa Desktop launcher — cross-platform (Linux + macOS).
#
# Launches the Electron shell against the PUBLIC dev image (pulled on first run — no clone, no build), and
# seeds a few demo screens declared the Milpa way (screen:declare) so the preview pane has something to show.
#
#   sh run-desktop.sh
#
# Env overrides:
#   MILPA_IMAGE            image to run (default: ghcr.io/getmilpa/framework:dev — public, no auth)
#   MILPA_AGENT_BASE_URL   the model endpoint (default: http://llama.local:11438) — set to your own LAN IP
#                          if `.local` mDNS does not resolve inside the container (common on macOS Docker).
#   MILPA_AGENT_MODEL      the model name (default: qwen3.8-27b)
#   MILPA_AGENT_CONTEXT_TOKENS  the model's context budget (default: 24576 — qwen-32k minus the
#                          Desktop's tool-schema share; raise it for bigger models)
#
# (c) Rodrigo Vicente - TeamX Agency — Apache-2.0
set -u
cd "$(dirname "$0")"                                   # repo root
IMAGE="${MILPA_IMAGE:-ghcr.io/getmilpa/framework:dev}"
export MILPA_IMAGE="$IMAGE"

# Platform: Linux needs a display; macOS does not. The container network (host vs -p) is chosen by main.js.
case "$(uname -s)" in
  Linux*)  export DISPLAY="${DISPLAY:-:0}" ;;
  Darwin*) : ;;
  *) echo "unsupported OS: $(uname -s)"; exit 1 ;;
esac

# Resolve the Electron binary the canonical, platform-correct way (no hardcoded dist path). `.trim()` guards
# against an install whose path.txt carries a trailing newline — that stray "\n" is what made `electron .`
# and a raw require() spawn a bogus ".../electron\n" and fail with ENOENT.
ELECTRON="$(node -e 'process.stdout.write(String(require("electron")).trim())' 2>/dev/null)"
if [ -z "$ELECTRON" ] || [ ! -x "$ELECTRON" ]; then
  echo "Electron not installed. Run first:  npm install"
  exit 1
fi

# Pull the public image once if it is missing (no local build — the framework arrives inside the container).
if ! docker image inspect "$IMAGE" >/dev/null 2>&1; then
  echo "→ pulling $IMAGE once (public, no auth)…"
  docker pull "$IMAGE" || { echo "image pull failed — is Docker running?"; exit 1; }
fi

# Clean any stale backend, then launch the shell detached (survives closing this terminal).
# MILPA_KEEP_BACKEND=1 attaches to the running backend instead — the sessions inside survive a UI
# restart. This line was the killer main.js's knob could not see: the launcher murdered the container
# before Electron ever started (measured: a 48-turn session died with it).
[ "${MILPA_KEEP_BACKEND:-}" = "1" ] || docker rm -f milpa-desktop-backend >/dev/null 2>&1 || true
pkill -9 -f 'electron/dist/electron' >/dev/null 2>&1 || true
sleep 1
nohup "$ELECTRON" . >/tmp/milpa-desktop.log 2>&1 < /dev/null &
echo "→ Milpa Desktop launching (image: $IMAGE)…"

# Wait for the backend the shell starts, then seed demo screens.
for _ in $(seq 1 60); do docker ps 2>/dev/null | grep -q milpa-desktop-backend && break; sleep 1; done
sleep 2
docker exec milpa-desktop-backend php -r '
require "vendor/autoload.php";
$s = new Milpa\AppRuntime\Web\ScreenStore(getcwd()."/var/screens.json");
$s->declare(["name"=>"salud","type"=>"metric-card","props"=>["title"=>"Uptime","value"=>"99.9%","trend"=>"up","caption"=>"last 30d"]]);
$s->declare(["name"=>"flujo","type"=>"state-machine","props"=>["machine"=>["initial"=>"draft","transitions"=>["draft"=>["publish"=>["to"=>"live"]],"live"=>["retire"=>["to"=>"archived"]],"archived"=>[]]]]]);
$s->declare(["name"=>"panel","type"=>"dashboard-grid","props"=>["children"=>[
  ["type"=>"metric-card","props"=>["title"=>"Revenue","value"=>"12.4k","trend"=>"up"]],
  ["type"=>"data-table","props"=>["columns"=>[["key"=>"task","label"=>"Task"],["key"=>"owner","label"=>"Owner"]],"rows"=>[["task"=>"Close the arc","owner"=>"rod"],["task"=>"See the UI","owner"=>"agent"]]]],
]]]);
echo "seeded demo screens: salud, flujo, panel (+ tasks)\n";
' 2>&1 | tail -1 || echo "(backend not up yet — the shell will still open; seed later)"
echo "✓ ready. In the Desktop: Components → type  tasks · salud · flujo · panel  → Preview"
