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

# 0b) DSH 官方 bug 守护：persistent bash「执行 bash 卡住」。
#     DSH 的 persistent bash 工具用交互式 bash(-i) 跑命令，并按
#     `printf START; eval -- $'<cmd>'; printf END` 把命令压成一行写入 PTY。
#     bash 3.2.57（macOS 自带）的 history expansion 先于解析执行，而它的引号
#     扫描器不认识 $'…'：命令里出现单引号（被 quoteForBash 转义成 \'）之后
#     再出现 `!`（heredoc 内容、`!=`、`<!--`、`#!/` 等很常见）时，扫描器会
#     提前结束单引号区，把 `!` 当事件指示符 → `event not found` → 整行被
#     bash 丢弃 → START/END 标记都不打印 → executeCommand() 的轮询匹配不到
#     结束标记，一直卡到 timeoutMs（默认 300s）才超时并重置持久 shell
#     （丢失 cwd / 环境变量）。
#     上游记录与一行修复：deepseek-harness discussion #5046
#       - text: 'stty -echo'
#       + text: 'stty -echo; set +o histexpand'
#     （set +o histexpand == set +H；在 bash 5.3.9 上冗余但无害。）
#     幂等：只在官方包那唯一的初始化行上替换一次，备份为
#     index.js.orig-no-histexpand。DSH / App 升级会覆盖，需重跑本脚本。
#     默认只修 PATH 里的 dsh CLI 与 profile hoist 副本；Desktop.app 内置副
#     本会破坏 App 代码签名，故只在 DSH_PATCH_DESKTOP_APP=1 时才动。
if [ "${DSH_PATCH_BASH_INIT:-1}" = "1" ]; then
  BASH_PATCH_CANDIDATES=()
  if command -v dsh >/dev/null 2>&1; then
    dsh_bin="$(command -v dsh)"
    while [ -L "$dsh_bin" ]; do
      link="$(readlink "$dsh_bin")"
      case "$link" in
        /*) dsh_bin="$link" ;;
        *) dsh_bin="$(cd "$(dirname "$dsh_bin")" && pwd)/$link" ;;
      esac
    done
    dsh_root="$(cd "$(dirname "$dsh_bin")/.." && pwd)"
    echo "    bash-fix dsh root: $dsh_root"
    BASH_PATCH_CANDIDATES+=("$dsh_root/node_modules/@deepseek-ai/dsh-tool-bash-persistent/lib/index.js")
    BASH_PATCH_CANDIDATES+=("$dsh_root/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tool-bash-persistent/lib/index.js")
  fi
  BASH_PATCH_CANDIDATES+=("$NODE_MODULES_DIR/@deepseek-ai/dsh-tool-bash-persistent/lib/index.js")
  BASH_PATCH_CANDIDATES+=("$NODE_MODULES_DIR/@deepseek-ai/dsh/node_modules/@deepseek-ai/dsh-tool-bash-persistent/lib/index.js")
  if [ "${DSH_PATCH_DESKTOP_APP:-0}" = "1" ]; then
    BASH_PATCH_CANDIDATES+=("/Applications/DSH Desktop.app/Contents/Resources/app/node_modules/@deepseek-ai/dsh-tool-bash-persistent/lib/index.js")
  fi
  python3 - ${BASH_PATCH_CANDIDATES[@]+"${BASH_PATCH_CANDIDATES[@]}"} <<'PY'
import os, sys

OLD = 'text: "stty -echo"'
NEW = 'text: "stty -echo; set +o histexpand"'
patched = already = skipped = 0
for path in dict.fromkeys(sys.argv[1:]):
    if not path or not os.path.isfile(path):
        continue
    try:
        with open(path, encoding="utf-8") as fh:
            src = fh.read()
    except OSError as err:
        print(f"    bash-fix {path} (read failed: {err})")
        skipped += 1
        continue
    if NEW in src:
        print(f"    bash-fix {path} (already patched)")
        already += 1
        continue
    if src.count(OLD) != 1:
        print(f"    bash-fix {path} (expected exactly 1 init line, found {src.count(OLD)}; skipped)")
        skipped += 1
        continue
    backup = path + ".orig-no-histexpand"
    try:
        if not os.path.exists(backup):
            with open(backup, "w", encoding="utf-8") as fh:
                fh.write(src)
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(src.replace(OLD, NEW))
    except OSError as err:
        print(f"    bash-fix {path} (write failed: {err}; re-run with write permission)")
        skipped += 1
        continue
    print(f"    bash-fix {path} (patched, backup {os.path.basename(backup)})")
    patched += 1
print(f"    bash-fix result: patched={patched} already={already} skipped={skipped}")
PY
fi

# 0c) DSH/pi-ai 内置的 opencode-go 模型目录过时：这里在每次部署时用
#     patches/opencode-go.models.json 覆盖生成数据，只保留 Go 文档声明的
#     DeepSeek 全套（含规范 ID deepseek-flash）和 Muse Spark 1.3 Contributor。
#     注意：Muse Spark 1.3 Contributor Free 只能在 OpenCode 内用，第三方
#     harness 会收到 403 FreeTierError，因此这里挂 Go 端点上的付费 contributor。
#     幂等：内容一致就跳过；首次写入前备份为 .orig-opencode-go-models。
#     DSH/pi-ai 升级会覆盖该文件，需重跑本脚本。
OPENCODE_GO_PATCH="$HERE/patches/opencode-go.models.json"
if [ -f "$OPENCODE_GO_PATCH" ]; then
  OPENCODE_GO_TARGETS=(
    "$NODE_MODULES_DIR/@earendil-works/pi-ai/dist/providers/data/opencode-go.json"
    "$NODE_MODULES_DIR/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai/dist/providers/data/opencode-go.json"
  )
  if command -v dsh >/dev/null 2>&1; then
    ocgo_dsh_bin="$(command -v dsh)"
    while [ -L "$ocgo_dsh_bin" ]; do
      ocgo_link="$(readlink "$ocgo_dsh_bin")"
      case "$ocgo_link" in
        /*) ocgo_dsh_bin="$ocgo_link" ;;
        *) ocgo_dsh_bin="$(cd "$(dirname "$ocgo_dsh_bin")" && pwd)/$ocgo_link" ;;
      esac
    done
    ocgo_dsh_root="$(cd "$(dirname "$ocgo_dsh_bin")/.." && pwd)"
    OPENCODE_GO_TARGETS+=("$ocgo_dsh_root/node_modules/@earendil-works/pi-ai/dist/providers/data/opencode-go.json")
    OPENCODE_GO_TARGETS+=("$ocgo_dsh_root/node_modules/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai/dist/providers/data/opencode-go.json")
  fi
  python3 - "$OPENCODE_GO_PATCH" "${OPENCODE_GO_TARGETS[@]}" <<'PY'
import json, os, shutil, sys

patch_path = sys.argv[1]
with open(patch_path, encoding="utf-8") as fh:
    patch = json.load(fh)
patch_text = json.dumps(patch, indent=2, ensure_ascii=False) + "\n"

patched = already = skipped = 0
seen = set()
for target in sys.argv[2:]:
    if not target:
        continue
    real = os.path.realpath(os.path.expanduser(target))
    if real in seen:
        continue
    seen.add(real)
    if not os.path.isfile(real):
        continue
    try:
        with open(real, encoding="utf-8") as fh:
            current_text = fh.read()
    except OSError as err:
        print(f"    opencode-go models {real} (read failed: {err})")
        skipped += 1
        continue
    try:
        current = json.loads(current_text)
    except Exception as err:
        print(f"    opencode-go models {real} (invalid JSON: {err}; skipped)")
        skipped += 1
        continue
    if current == patch:
        print(f"    opencode-go models {real} (already patched)")
        already += 1
        continue
    backup = real + ".orig-opencode-go-models"
    backup_note = ""
    try:
        if os.path.exists(backup):
            backup_note = "existing backup"
        else:
            try:
                shutil.copy2(real, backup)
                backup_note = f"backup {os.path.basename(backup)}"
            except OSError:
                shutil.copyfile(real, backup)
                backup_note = f"backup {os.path.basename(backup)} (metadata copy skipped)"
    except OSError as err:
        print(f"    opencode-go models {real} (backup failed: {err}; continuing without backup)")
    try:
        with open(real, "w", encoding="utf-8") as fh:
            fh.write(patch_text)
    except OSError as err:
        print(f"    opencode-go models {real} (write failed: {err}; re-run with write permission)")
        skipped += 1
        continue
    print(f"    opencode-go models {real} (patched{'; ' + backup_note if backup_note else ''})")
    patched += 1
print(f"    opencode-go models result: patched={patched} already={already} skipped={skipped}")
PY
fi

# 0d) OpenCode Go 兼容修复：pi-ai 的 OpenAI-compatible client 默认不会发
#     x-opencode-session；Go 网关缺这个头会返回 400 MissingSessionID，
#     客户端常把它显示成 “API key invalid”。这里给 opencode-go provider
#     补上该头：优先用 DSH 传入的 sessionId，缺失时用固定值兜底，保证
#     请求至少能被网关路由。幂等：已含该头则跳过。
SESSION_PATCH_TARGETS=(
  "$NODE_MODULES_DIR/@earendil-works/pi-ai/dist/api/openai-completions.js"
  "$NODE_MODULES_DIR/@earendil-works/pi-ai/dist/api/openai-responses.js"
  "$NODE_MODULES_DIR/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js"
  "$NODE_MODULES_DIR/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js"
)
if command -v dsh >/dev/null 2>&1; then
  session_dsh_bin="$(command -v dsh)"
  while [ -L "$session_dsh_bin" ]; do
    session_link="$(readlink "$session_dsh_bin")"
    case "$session_link" in
      /*) session_dsh_bin="$session_link" ;;
      *) session_dsh_bin="$(cd "$(dirname "$session_dsh_bin")" && pwd)/$session_link" ;;
    esac
  done
  session_dsh_root="$(cd "$(dirname "$session_dsh_bin")/.." && pwd)"
  SESSION_PATCH_TARGETS+=("$session_dsh_root/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js")
  SESSION_PATCH_TARGETS+=("$session_dsh_root/node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js")
  SESSION_PATCH_TARGETS+=("$session_dsh_root/node_modules/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai/dist/api/openai-completions.js")
  SESSION_PATCH_TARGETS+=("$session_dsh_root/node_modules/@deepseek-ai/dsh/node_modules/@earendil-works/pi-ai/dist/api/openai-responses.js")
fi
python3 - "${SESSION_PATCH_TARGETS[@]}" <<'PY'
import os, shutil, sys

OLD_COMPLETIONS = '''    if (sessionId && compat.sendSessionAffinityHeaders) {
        if (compat.sessionAffinityFormat === "openrouter") {
            headers["x-session-id"] = sessionId;
        }
        else {
            if (compat.sessionAffinityFormat === "openai") {
                headers.session_id = sessionId;
            }
            headers["x-client-request-id"] = sessionId;
            headers["x-session-affinity"] = sessionId;
        }
    }
'''
OLD_RESPONSES = '''    if (sessionId) {
        if (compat.sessionAffinityFormat === "openrouter") {
            headers["x-session-id"] = sessionId;
        }
        else {
            if (compat.sessionAffinityFormat === "openai") {
                headers.session_id = sessionId;
            }
            headers["x-client-request-id"] = sessionId;
        }
    }
'''
ADD = '''    if (model.provider === "opencode-go") {
        headers["x-opencode-session"] = sessionId || "dsh-opencode-go";
    }
'''

patched = already = skipped = 0
seen = set()
for target in sys.argv[1:]:
    if not target:
        continue
    real = os.path.realpath(os.path.expanduser(target))
    if real in seen:
        continue
    seen.add(real)
    if not os.path.isfile(real):
        continue
    try:
        with open(real, encoding="utf-8") as fh:
            src = fh.read()
    except OSError as err:
        print(f"    opencode-session {real} (read failed: {err})")
        skipped += 1
        continue
    if "x-opencode-session" in src:
        print(f"    opencode-session {real} (already patched)")
        already += 1
        continue
    if real.endswith("openai-completions.js"):
        old = OLD_COMPLETIONS
    elif real.endswith("openai-responses.js"):
        old = OLD_RESPONSES
    else:
        continue
    if src.count(old) != 1:
        print(f"    opencode-session {real} (expected exactly 1 session block, found {src.count(old)}; skipped)")
        skipped += 1
        continue
    backup = real + ".orig-opencode-session"
    try:
        if not os.path.exists(backup):
            try:
                shutil.copy2(real, backup)
            except OSError:
                shutil.copyfile(real, backup)
    except OSError as err:
        print(f"    opencode-session {real} (backup failed: {err}; continuing without backup)")
    try:
        with open(real, "w", encoding="utf-8") as fh:
            fh.write(src.replace(old, old + ADD, 1))
    except OSError as err:
        print(f"    opencode-session {real} (write failed: {err}; re-run with write permission)")
        skipped += 1
        continue
    print(f"    opencode-session {real} (patched, backup {os.path.basename(backup)})")
    patched += 1
print(f"    opencode-session result: patched={patched} already={already} skipped={skipped}")
PY

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
#    per line, `#` comments, versions pinned (no @latest). DSH 的受保护插件安装
#    必须走 dshpm（plugin_install 底层同一链路），裸 `dsh plugin add` 会被守卫拦截。
REQ_FILE="$HERE/plugins/requirements.txt"
if [ -f "$REQ_FILE" ]; then
  DSHPM_BIN="$WEB_DIR/node_modules/.bin/dshpm"
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    case "$line" in
      ''|'#'*) continue ;;
    esac
    echo "    ext      $line"
    if [ -x "$DSHPM_BIN" ]; then
      "$DSHPM_BIN" install "$line" --profile web
    else
      node "$WEB_DIR/node_modules/dsh-web-plugin-manager/dist/cli.js" install "$line" --profile web
    fi
  done < "$REQ_FILE"
else
  echo "    ext      plugins/requirements.txt not found (skipped)"
fi

echo "==> Done. Restart 'dsh web' to apply changes."
