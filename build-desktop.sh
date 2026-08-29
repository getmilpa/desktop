#!/usr/bin/env bash
# Build the distributable Milpa Desktop for THIS platform and emit checksums for a GitHub Release.
#
#   sh build-desktop.sh
#
#   Linux → dist/Milpa-Desktop-<ver>-<arch>.AppImage
#   macOS → dist/Milpa-Desktop-<ver>-<arch>.dmg + .zip   (run this ON a Mac)
#   both  → dist/SHA256SUMS.txt
#
# electron-builder cannot cross-compile to macOS from Linux, so build each platform on its own machine.
#
# (c) Rodrigo Vicente - TeamX Agency — Apache-2.0
set -eu
cd "$(dirname "$0")"

# Install build deps once.
if [ ! -x node_modules/.bin/electron-builder ]; then
  echo "→ installing build deps (npm install)…"
  npm install
fi

# Target + checksum tool per platform.
case "$(uname -s)" in
  Linux*)  BUILD="dist";     SUM="sha256sum" ;;
  Darwin*) BUILD="dist:mac"; SUM="shasum -a 256" ;;
  *) echo "unsupported OS: $(uname -s)"; exit 1 ;;
esac

echo "→ building the distributable ($(uname -s))…"
npm run "$BUILD"

# Checksum every release artifact (installers/images, not the unpacked dir). Quoting handles spaces.
cd dist
: > SHA256SUMS.txt
found=0
for ext in AppImage dmg zip; do
  for f in *."$ext"; do
    [ -e "$f" ] || continue
    $SUM "$f" >> SHA256SUMS.txt
    found=1
  done
done
[ "$found" = 1 ] || { echo "no artifacts produced"; exit 1; }

echo
echo "✓ release-ready in $(pwd):"
for ext in AppImage dmg zip; do
  for f in *."$ext"; do
    [ -e "$f" ] || continue
    printf '  %-44s %s\n' "$f" "$(du -h "$f" | cut -f1)"
  done
done
echo
echo "SHA256SUMS.txt:"
sed 's/^/  /' SHA256SUMS.txt
echo
echo "Next: create a GitHub Release and upload the artifact(s) + SHA256SUMS.txt."
