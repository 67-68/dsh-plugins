# install/lib/guard-bash-histexpand.sh — 0b) persistent bash「执行 bash 卡住」修复。
# 由 install.sh source 执行（同一 shell），不要直接运行。
# DSH 的 persistent bash 工具用交互式 bash(-i) 跑命令，并按
# `printf START; eval -- $'<cmd>'; printf END` 把命令压成一行写入 PTY。
# bash 3.2.57（macOS 自带）的 history expansion 先于解析执行，而它的引号
# 扫描器不认识 $'…'：命令里出现单引号（被 quoteForBash 转义成 \'）之后
# 再出现 `!`（heredoc 内容、`!=`、`<!--`、`#!/` 等很常见）时，扫描器会
# 提前结束单引号区，把 `!` 当事件指示符 → `event not found` → 整行被
# bash 丢弃 → START/END 标记都不打印 → executeCommand() 的轮询匹配不到
# 结束标记，一直卡到 timeoutMs（默认 300s）才超时并重置持久 shell
# （丢失 cwd / 环境变量）。
# 上游记录与一行修复：deepseek-harness discussion #5046
#   - text: 'stty -echo'
#   + text: 'stty -echo; set +o histexpand'
# （set +o histexpand == set +H；在 bash 5.3.9 上冗余但无害。）
# 幂等：只在官方包那唯一的初始化行上替换一次，备份为
# index.js.orig-no-histexpand。DSH / App 升级会覆盖，需重跑本脚本。
# 默认只修 PATH 里的 dsh CLI 与 profile hoist 副本；Desktop.app 内置副
# 本会破坏 App 代码签名，故只在 DSH_PATCH_DESKTOP_APP=1 时才动。
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
