# install/lib/sync-external.sh — 6) 外部插件声明安装。
# 由 install.sh source 执行（同一 shell），不要直接运行。
# External plugins declared in plugins/requirements.txt: one `source@version`
# per line, `#` comments, versions pinned (no @latest). DSH 的受保护插件安装
# 必须走 dshpm（plugin_install 底层同一链路），裸 `dsh plugin add` 会被守卫拦截。
REQ_FILE="$HERE/plugins/requirements.txt"
if [ -f "$REQ_FILE" ]; then
  DSHPM_BIN="$WEB_DIR/node_modules/.bin/dshpm"
  # 增速：一次取已装版本表，逐行匹配命中则跳过 install（dshpm install 每次走
  # 质量门 + 可能的网络，重复执行是主要耗时）。匹配规则：
  #   name@version → 已装表含 "name (version)" 则跳过；
  #   bare name    → 已装表含 "name (" 则跳过（存在性检查）；
  #   URL          → 已装表含 "(URL)" 则跳过（固定来源视为版本锁定）。
  # dshpm 不可用时 INSTALLED 为空，全部走安装（与旧行为一致）。
  INSTALLED=""
  if [ -x "$DSHPM_BIN" ]; then
    INSTALLED="$("$DSHPM_BIN" list --profile web 2>/dev/null || true)"
  fi
  while IFS= read -r line || [ -n "$line" ]; do
    line="${line%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    case "$line" in
      ''|'#'*) continue ;;
    esac
    if [ -n "$INSTALLED" ]; then
      case "$line" in
        *://*)
          if printf '%s\n' "$INSTALLED" | grep -qF -- "($line)"; then
            echo "    ext      $line (already installed, skipped)"
            continue
          fi
          ;;
        *@*)
          _name="${line%@*}"
          _ver="${line##*@}"
          if printf '%s\n' "$INSTALLED" | grep -qF -- "$_name ($_ver)"; then
            echo "    ext      $line (already installed, skipped)"
            continue
          fi
          ;;
        *)
          if printf '%s\n' "$INSTALLED" | grep -qF -- "$line ("; then
            echo "    ext      $line (already installed, skipped)"
            continue
          fi
          ;;
      esac
    fi
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
