# install/lib/sync-docs.sh — 4) document/*.md symlink 进 DSH_HOME/DOCUMENT。
# 由 install.sh source 执行（同一 shell），不要直接运行。
# (*.md, recursive) preserving subdirs (e.g. feature_intent/ module docs).
while IFS= read -r src; do
  rel="${src#"$HERE"/document/}"
  dest="$DOC_DIR/$rel"
  mkdir -p "$(dirname "$dest")"
  if [ "$(readlink "$dest" 2>/dev/null || true)" = "$src" ]; then
    echo "    doc      $rel (already linked)"
  else
    ln -sfn "$src" "$dest" 2>/dev/null || echo "    doc      $rel (link skipped: permission)"
  fi
done < <(find "$HERE"/document -name '*.md' -type f)
