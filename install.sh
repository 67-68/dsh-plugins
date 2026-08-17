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
NODE_MODULES_DIR="$DSH_HOME/profiles/node_modules"

mkdir -p "$WEB_DIR" "$PRESET_DIR" "$DOC_DIR" "$NODE_MODULES_DIR"

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
# Presets must be REAL directories, not symlinks: agent-presets discovery does
# readdir(..., { withFileTypes: true }) and skips any child where
# child.isDirectory() is false — and a symlink reports isDirectory() === false.
# So unlike the plugins/docs above, a symlinked preset is silently never seen.
for dir in "$HERE"/presets/*/; do
  [ -d "$dir" ] || continue
  name="$(basename "$dir")"
  # Replace an existing real dir or stale symlink with a fresh copy.
  rm -rf "$PRESET_DIR/$name"
  cp -R "$dir" "$PRESET_DIR/$name"
  echo "    preset   $name (copied)"
done

# 4) Docs (*.md, recursive) into DSH_HOME/DOCUMENT, preserving subdirs
#    (e.g. feature_intent/ module docs).
while IFS= read -r src; do
  rel="${src#"$HERE"/document/}"
  dest="$DOC_DIR/$rel"
  mkdir -p "$(dirname "$dest")"
  ln -sfn "$src" "$dest"
  echo "    doc      $rel"
done < <(find "$HERE"/document -name '*.md' -type f)

# 4b) Build the mermaid static asset if it is missing, so the cp -R below
#     ships a ready-to-serve IIFE bundle. Idempotent: skip when already built.
MERMAID_ASSET="$HERE/packages/dsh-mermaid/lib/assets/mermaid.js"
if [ -f "$MERMAID_ASSET" ]; then
  echo "    asset    dsh-mermaid mermaid.js (already built)"
else
  echo "    asset    building dsh-mermaid mermaid.js"
  node "$HERE/scripts/build-mermaid.mjs"
fi

# 5) Local dual-face packages (packages/*/ one dir each) copied into the
#    profile's hoisted node_modules. pnpm hoists the profile's node_modules up
#    to $DSH_HOME/profiles/node_modules (not profiles/web/node_modules), so the
#    package must live there for the profile to resolve it.
#    Symlinks do NOT work here: Node realpaths the module and then resolves the
#    package's bare peer imports (e.g. @deepseek-ai/dsh-typert-protocol) from
#    the repo dir, which has no node_modules. A real copy keeps the module
#    physically under profiles/node_modules so its peers resolve.
for dir in "$HERE"/packages/*/; do
  [ -d "$dir" ] || continue
  name="$(basename "$dir")"
  # Replace an existing real dir or stale symlink with a fresh copy.
  rm -rf "$NODE_MODULES_DIR/$name"
  cp -R "$dir" "$NODE_MODULES_DIR/$name"
  echo "    package  $name (copied)"
done

# 6) External plugins declared in plugins/requirements.txt: one `source@version`
#    per line, `#` comments, versions pinned (no @latest). `dsh plugin add` is a
#    pnpm forwarder that installs into the profile and reconciles bundles; adding
#    an already-installed version is a no-op, so re-running stays idempotent.
REQ_FILE="$HERE/plugins/requirements.txt"
if [ -f "$REQ_FILE" ]; then
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    case "$line" in
      ''|'#'*) continue ;;
    esac
    echo "    ext      $line"
    npx --yes @deepseek-ai/dsh plugin --profile web add "$line"
  done < "$REQ_FILE"
else
  echo "    ext      plugins/requirements.txt not found (skipped)"
fi

echo "==> Done. Restart 'dsh web' to apply changes."
