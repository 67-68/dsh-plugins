# install/lib/guard-opencode-models.sh — 0c) opencode-go 模型目录覆盖。
# 由 install.sh source 执行（同一 shell），不要直接运行。
# DSH/pi-ai 内置的 opencode-go 模型目录过时：这里在每次部署时用
# patches/opencode-go.models.json 覆盖生成数据，只保留 Go 文档声明的
# DeepSeek 全套（含规范 ID deepseek-flash）和 Muse Spark 1.3 Contributor。
# 注意：Muse Spark 1.3 Contributor Free 只能在 OpenCode 内用，第三方
# harness 会收到 403 FreeTierError，因此这里挂 Go 端点上的付费 contributor。
# 幂等：内容一致就跳过；首次写入前备份为 .orig-opencode-go-models。
# DSH/pi-ai 升级会覆盖该文件，需重跑本脚本。
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
