# install/lib/guard-opencode-session.sh — 0d) opencode-go 会话头兼容修复。
# 由 install.sh source 执行（同一 shell），不要直接运行。
# pi-ai 的 OpenAI-compatible client 默认不会发 x-opencode-session；Go 网关
# 缺这个头会返回 400 MissingSessionID，客户端常把它显示成 “API key invalid”。
# 这里给 opencode-go provider 补上该头：优先用 DSH 传入的 sessionId，缺失时
# 用固定值兜底，保证请求至少能被网关路由。幂等：已含该头则跳过。
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
