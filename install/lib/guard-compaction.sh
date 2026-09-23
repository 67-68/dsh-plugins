# install/lib/guard-compaction.sh — 0e) host plane compaction-basic 覆盖守护。
# 由 install.sh source 执行（同一 shell），不要直接运行。
# dsh-web-app bundle 默认禁用 host plane 的 compaction-basic（compaction
# backend 移到 preset 层），但 dsh-mode-gate 在 host plane 上 inject 了
# compaction 服务，host plane 缺它会导致插件树加载失败
# （"dsh-mode-gate: pending (waiting for service: compaction)"）。
# 这里幂等地确保用户层 cordis.patch.yml 始终带 compaction-basic 覆盖
# （disabled: false）。dsh-web-plugin-manager 重写 cordis.patch.yml 或
# DSH 升级后需重跑本脚本。
COMPACTION_GUARD_TARGET="$WEB_DIR/cordis.patch.yml"
if [ -f "$COMPACTION_GUARD_TARGET" ]; then
  python3 - "$COMPACTION_GUARD_TARGET" <<'PY'
import os, sys

path = sys.argv[1]
BLOCK_FALSE = "- id: compaction-basic\n  disabled: false"
BLOCK_TRUE = "- id: compaction-basic\n  disabled: true"
APPEND = (
    "\n"
    "# compaction-guard: 重新启用 host plane 的 compaction-basic（dsh-web-app\n"
    "# bundle 默认 disabled: true，但 dsh-mode-gate 在 host plane 上 inject 了\n"
    "# compaction 服务，缺它会导致插件树加载失败）。\n"
    "- id: compaction-basic\n"
    "  disabled: false\n"
)

try:
    with open(path, encoding="utf-8") as fh:
        src = fh.read()
except OSError as err:
    print(f"    compaction-guard {path} (read failed: {err})")
    sys.exit(0)

if BLOCK_FALSE in src:
    print(f"    compaction-guard {path} (already patched)")
    sys.exit(0)

backup = path + ".orig-compaction-guard"
try:
    if not os.path.exists(backup):
        with open(backup, "w", encoding="utf-8") as fh:
            fh.write(src)
except OSError as err:
    print(f"    compaction-guard {path} (backup failed: {err}; continuing without backup)")

try:
    if BLOCK_TRUE in src:
        with open(path, "w", encoding="utf-8") as fh:
            fh.write(src.replace(BLOCK_TRUE, BLOCK_FALSE, 1))
        print(f"    compaction-guard {path} (disabled: true -> false)")
    else:
        with open(path, "a", encoding="utf-8") as fh:
            fh.write(APPEND)
        print(f"    compaction-guard {path} (appended disabled: false override)")
except OSError as err:
    print(f"    compaction-guard {path} (write failed: {err}; re-run with write permission)")
PY
fi
