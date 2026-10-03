#!/usr/bin/env sh
# Run the Milpa Desktop smoke tests with the resolved Electron binary — under xvfb on a headless Linux box: the
# workspace renderer (smoke.js), then the boot screen the window shows while the house comes up (smoke-boot.js).
DIR="$(cd "$(dirname "$0")/.." && pwd)"
ELECTRON="$(node -p 'require("electron")')"
status=0
# Which image a launch runs when nobody names one — plain node, a fake docker (greenhouse evidence/1095, G1).
node "$DIR/test/choose-image.js" || status=1
for SMOKE in "$DIR/test/smoke.js" "$DIR/test/smoke-boot.js"; do
  if [ "$(uname)" = "Linux" ] && [ -z "$DISPLAY" ]; then
    xvfb-run -a --server-args='-screen 0 1320x840x24' "$ELECTRON" "$SMOKE" || status=1
  else
    "$ELECTRON" "$SMOKE" || status=1
  fi
done
exit $status
