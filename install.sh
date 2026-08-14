#!/usr/bin/env bash
# Deploy dsh-plugins into the running DSH home via symlinks.
# Edits in this repo become live after a `dsh web` restart (web HMR is off).
#
# Usage:
#   ./install.sh            # deploy to ${DSH_HOME:-$HOME/.dsh}
#   ./install.sh /path      # deploy to a specific DSH home

set -euo pipefail

DSH_HOME="${1:-${DSH_HOME:-$HOME/.dsh}}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

WEB_DIR="$DSH_HOME/profiles/web"
PRESET_DIR="$DSH_HOME/.agent-presets"
DOC_DIR="$DSH_HOME/DOCUMENT"

mkdir -p "$WEB_DIR" "$PRESET_DIR" "$DOC_DIR"

echo "==> Deploying dsh-plugins -> $DSH_HOME"

# 1) Host plugins (*.mjs) into the web profile dir.
for src in "$HERE"/plugins/*.mjs; do
  [ -e "$src" ] || continue
  name="$(basename "$src")"
  ln -sfn "$src" "$WEB_DIR/$name"
  echo "    plugin   $name"
done

# 2) cordis.patch.yml into the web profile dir.
if [ -f "$HERE/profile/cordis.patch.yml" ]; then
  ln -sfn "$HERE/profile/cordis.patch.yml" "$WEB_DIR/cordis.patch.yml"
  echo "    patch    cordis.patch.yml"
fi

# 3) Agent presets (one dir each) into .agent-presets.
for dir in "$HERE"/presets/*/; do
  [ -d "$dir" ] || continue
  name="$(basename "$dir")"
  # Replace an existing real dir or stale symlink with a fresh symlink.
  rm -rf "$PRESET_DIR/$name"
  ln -s "$dir" "$PRESET_DIR/$name"
  echo "    preset   $name"
done

# 4) Experience docs (*.md) into DSH_HOME/DOCUMENT.
for src in "$HERE"/document/*.md; do
  [ -e "$src" ] || continue
  name="$(basename "$src")"
  ln -sfn "$src" "$DOC_DIR/$name"
  echo "    doc      $name"
done

echo "==> Done. Restart 'dsh web' to apply changes."
