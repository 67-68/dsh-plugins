# install/lib/sync-presets.sh — 3) agent presets 真实目录拷贝进 .agent-presets。
# 由 install.sh source 执行（同一 shell），不要直接运行。
# Presets must be REAL directories, not symlinks: agent-presets discovery does
# readdir(..., { withFileTypes: true }) and skips any child where
# child.isDirectory() is false — and a symlink reports isDirectory() === false.
# So unlike the plugins/docs above, a symlinked preset is silently never seen.
for dir in "$HERE"/presets/*/; do
  [ -d "$dir" ] || continue
  name="$(basename "$dir")"
  # 增速：内容一致则跳过 rm + cp（diff 按内容比对，毫秒级）。
  if [ -d "$PRESET_DIR/$name" ] && diff -rq "$dir" "$PRESET_DIR/$name" >/dev/null 2>&1; then
    echo "    preset   $name (unchanged, skipped)"
    continue
  fi
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
