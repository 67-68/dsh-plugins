# install/lib/sync-packages.sh — 5) 本地双面包插件真实目录拷贝。
# 由 install.sh source 执行（同一 shell），不要直接运行。
# Local dual-face packages (packages/*/ one dir each) copied into the
# profile's hoisted node_modules. pnpm hoists the profile's node_modules up
# to $DSH_HOME/profiles/node_modules (not profiles/web/node_modules), so the
# package must live there for the profile to resolve it.
# Symlinks do NOT work here: Node realpaths the module and then resolves the
# package's bare peer imports (e.g. @deepseek-ai/dsh-typert-protocol) from
# the repo dir, which has no node_modules. A real copy keeps the module
# physically under profiles/node_modules so its peers resolve.
for dir in "$HERE"/packages/*/; do
  [ -d "$dir" ] || continue
  name="$(basename "$dir")"
  # 增速：内容一致则跳过 rm + cp。目标端若被运行时写入新文件则 diff 必不一致，
  # 自动回落到原来的替换逻辑。
  if [ -d "$NODE_MODULES_DIR/$name" ] && diff -rq "$dir" "$NODE_MODULES_DIR/$name" >/dev/null 2>&1; then
    echo "    package  $name (unchanged, skipped)"
    continue
  fi
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
