# install/lib/sync-plugins.sh — 1) host plugins (*.mjs) symlink 进 web profile。
# 由 install.sh source 执行（同一 shell），不要直接运行。
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
