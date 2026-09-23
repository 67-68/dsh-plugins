# install/lib/sync-profile.sh — 2) cordis.patch.yml symlink 进 web profile。
# 由 install.sh source 执行（同一 shell），不要直接运行。
if [ -f "$HERE/profile/cordis.patch.yml" ]; then
  if [ "$(readlink "$WEB_DIR/cordis.patch.yml" 2>/dev/null || true)" = "$HERE/profile/cordis.patch.yml" ]; then
    echo "    patch    cordis.patch.yml (already linked)"
  else
    ln -sfn "$HERE/profile/cordis.patch.yml" "$WEB_DIR/cordis.patch.yml" 2>/dev/null || cp -f "$HERE/profile/cordis.patch.yml" "$WEB_DIR/cordis.patch.yml"
    echo "    patch    cordis.patch.yml"
  fi
fi
