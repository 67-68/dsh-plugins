# install/lib/sync-preset-actions.sh — 3c) preset actions 真实目录拷贝。
# 由 install.sh source 执行（同一 shell），不要直接运行。
# Real directories for the same reason as presets:
# mode-gate discovers them with readdir(..., { withFileTypes: true }).
PRESET_ACTIONS_DIR="$DSH_HOME/preset-actions"
mkdir -p "$PRESET_ACTIONS_DIR"
for dir in "$HERE"/preset-actions/*/; do
  [ -d "$dir" ] || continue
  name="$(basename "$dir")"
  # 增速：内容一致则跳过 rm + cp。
  if [ -d "$PRESET_ACTIONS_DIR/$name" ] && diff -rq "$dir" "$PRESET_ACTIONS_DIR/$name" >/dev/null 2>&1; then
    echo "    action   $name (unchanged, skipped)"
    continue
  fi
  rm -rf "$PRESET_ACTIONS_DIR/$name" 2>/dev/null || true
  if cp -R "$dir" "$PRESET_ACTIONS_DIR/$name" 2>/dev/null; then
    echo "    action   $name (copied)"
  else
    echo "    action   $name (copy skipped: permission)"
  fi
done
