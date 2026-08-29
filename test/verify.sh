#!/usr/bin/env sh
# Run the Milpa Desktop smoke test with the resolved Electron binary — under xvfb on a headless Linux box.
set -e
DIR="$(cd "$(dirname "$0")/.." && pwd)"
ELECTRON="$(node -p 'require("electron")')"
SMOKE="$DIR/test/smoke.js"
if [ "$(uname)" = "Linux" ] && [ -z "$DISPLAY" ]; then
  exec xvfb-run -a --server-args='-screen 0 1320x840x24' "$ELECTRON" "$SMOKE"
else
  exec "$ELECTRON" "$SMOKE"
fi
