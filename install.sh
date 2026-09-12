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

# 0) DSH 官方 bug 守护：profile 根 package.json 缺 version 字段（官方
#    initProfile 只写 name/private/dependencies/dsh），而官方
#    plugin-package-inventory-deepseek 扫描相对路径 entry（如
#    ./mode-experience.mjs）时会 nearestManifest 命中该 manifest，因缺
#    version 抛 "must declare non-empty name and version"，最终被包成
#    "DeepSeek request extension preparation failed"（REQUEST_EXTENSION）。
#    幂等补写 version=0.0.0。
MANIFEST="$WEB_DIR/package.json"
if [ -f "$MANIFEST" ]; then
  python3 - "$MANIFEST" <<'PY'
import json, sys
path = sys.argv[1]
with open(path, encoding="utf-8") as f:
    data = json.load(f)
if isinstance(data.get("version"), str) and data["version"]:
    print("    profile  package.json version already set")
else:
    data["version"] = "0.0.0"
    with open(path, "w", encoding="utf-8") as f:
        json.dump(data, f, indent=2, ensure_ascii=False)
        f.write("\n")
    print("    profile  package.json version -> 0.0.0 (DSH bug guard)")
PY
fi

echo "==> Deploying dsh-plugins -> $DSH_HOME"

# 1) Host plugins (*.mjs) into the web profile dir.
for src in "$HERE"/plugins/*.mjs; do
  [ -e "$src" ] || continue
  name="$(basename "$src")"
  if [ "$(readlink "$WEB_DIR/$name" 2>/dev/null || true)" = "$src" ]; then
    echo "    plugin   $name (already linked)"
    continue
  fi
  ln -sfn "$src" "$WEB_DIR/$name" 2>/dev/null || cp -f "$src" "$WEB_DIR/$name"
  echo "    plugin   $name"
done

# 2) cordis.patch.yml into the web profile dir.
if [ -f "$HERE/profile/cordis.patch.yml" ]; then
  if [ "$(readlink "$WEB_DIR/cordis.patch.yml" 2>/dev/null || true)" = "$HERE/profile/cordis.patch.yml" ]; then
    echo "    patch    cordis.patch.yml (already linked)"
  else
    ln -sfn "$HERE/profile/cordis.patch.yml" "$WEB_DIR/cordis.patch.yml" 2>/dev/null || cp -f "$HERE/profile/cordis.patch.yml" "$WEB_DIR/cordis.patch.yml"
    echo "    patch    cordis.patch.yml"
  fi
fi

# 3b) Deploy ankifyd + ankify-ai-core into a user-level app share, so Anki and
#     Raycast share one daemon and one core copy (no per-plugin vendoring).
ANKIFY_AI_HOME="${ANKIFY_AI_HOME:-$HOME/.local/share/ankify-ai}"
mkdir -p "$ANKIFY_AI_HOME/logs"
if cp "$HERE/ankifyd/ankifyd.py" "$ANKIFY_AI_HOME/ankifyd.py" 2>/dev/null; then
  rm -rf "$ANKIFY_AI_HOME/core" 2>/dev/null || true
  cp -R "$HERE/ankify-ai-core" "$ANKIFY_AI_HOME/core" 2>/dev/null || echo "    ankifyd  core copy skipped (permission)"
  echo "    ankifyd  $ANKIFY_AI_HOME/ankifyd.py (copied)"
else
  echo "    ankifyd  copy skipped (permission); not fatal for mode-gate"
fi

# 3d) Deploy the Anki add-on into the user's Anki addons21 directory.
#     Same user-level copy approach as ankifyd/core: Anki must load a real
#     directory from addons21, not a symlink to the repo.
#     Set ANKI_ADDONS_DIR to override auto-detection; if Anki is not installed,
#     the step is skipped with a hint instead of failing the whole install.
ANKI_ADDONS_DIR="${ANKI_ADDONS_DIR:-}"
if [ -z "$ANKI_ADDONS_DIR" ]; then
  case "$(uname -s)" in
    Darwin) ANKI_ADDONS_DIR="$HOME/Library/Application Support/Anki2/addons21" ;;
    Linux) ANKI_ADDONS_DIR="${XDG_DATA_HOME:-$HOME/.local/share}/Anki2/addons21" ;;
  esac
fi
if [ -n "$ANKI_ADDONS_DIR" ] && [ -d "$ANKI_ADDONS_DIR" ]; then
  rm -rf "$ANKI_ADDONS_DIR/ankify_ai_auditor" 2>/dev/null || true
  if cp -R "$HERE/addons21/ankify_ai_auditor" "$ANKI_ADDONS_DIR/ankify_ai_auditor" 2>/dev/null; then
    echo "    anki     $ANKI_ADDONS_DIR/ankify_ai_auditor (copied)"
  else
    echo "    anki     copy skipped (permission); not fatal for mode-gate"
  fi
else
  echo "    anki     addons21 not found; set ANKI_ADDONS_DIR to deploy the Anki plugin (skipped)"
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
  if ! rm -rf "$PRESET_DIR/$name" 2>/dev/null; then
    echo "    preset   $name (skipped: permission to replace existing dir)"
    continue
  fi
  if cp -R "$dir" "$PRESET_DIR/$name" 2>/dev/null; then
    echo "    preset   $name (copied)"
  else
    echo "    preset   $name (copy skipped: permission)"
  fi
done

# 3c) Preset actions (one dir each, each containing SKILL.md) into
#     $DSH_HOME/preset-actions. Real directories for the same reason as presets:
#     mode-gate discovers them with readdir(..., { withFileTypes: true }).
PRESET_ACTIONS_DIR="$DSH_HOME/preset-actions"
mkdir -p "$PRESET_ACTIONS_DIR"
for dir in "$HERE"/preset-actions/*/; do
  [ -d "$dir" ] || continue
  name="$(basename "$dir")"
  rm -rf "$PRESET_ACTIONS_DIR/$name" 2>/dev/null || true
  if cp -R "$dir" "$PRESET_ACTIONS_DIR/$name" 2>/dev/null; then
    echo "    action   $name (copied)"
  else
    echo "    action   $name (copy skipped: permission)"
  fi
done

# 4) Docs (*.md, recursive) into DSH_HOME/DOCUMENT, preserving subdirs
#    (e.g. feature_intent/ module docs).
while IFS= read -r src; do
  rel="${src#"$HERE"/document/}"
  dest="$DOC_DIR/$rel"
  mkdir -p "$(dirname "$dest")"
  if [ "$(readlink "$dest" 2>/dev/null || true)" = "$src" ]; then
    echo "    doc      $rel (already linked)"
  else
    ln -sfn "$src" "$dest" 2>/dev/null || echo "    doc      $rel (link skipped: permission)"
  fi
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
  if rm -rf "$NODE_MODULES_DIR/$name" 2>/dev/null; then
    if cp -R "$dir" "$NODE_MODULES_DIR/$name" 2>/dev/null; then
      echo "    package  $name (copied)"
    else
      echo "    package  $name (copy skipped: permission)"
    fi
  elif cp -R "$dir/." "$NODE_MODULES_DIR/$name/" 2>/dev/null; then
    echo "    package  $name (overwritten in place)"
  else
    echo "    package  $name (skipped: loaded by a running process; restart DSH then re-run install.sh)"
  fi
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
