# install/lib/sync-ankify.sh — 3b) ankify 工具链委托调用。
# 由 install.sh source 执行（同一 shell），不要直接运行。
# ankify 工具链已抽离到独立的 sibling 仓库 ankify_tools（含自己的
# install.sh 与 git repo）。这里只做委托调用，保持「跑 dsh-plugins/install.sh
# 即完成全部部署」的旧习惯；ankify 的部署逻辑单一事实源在 ankify_tools。
# 若该仓库不存在则跳过（非致命，dsh-plugins 本身与 ankify 无编译期耦合）。
ANKIFY_TOOLS_DIR="${ANKIFY_TOOLS_DIR:-$(cd "$HERE/.." && pwd)/ankify_tools}"
if [ -x "$ANKIFY_TOOLS_DIR/install.sh" ]; then
  echo "  ankify  -> $ANKIFY_TOOLS_DIR/install.sh"
  ANKIFY_AI_HOME="${ANKIFY_AI_HOME:-$HOME/.local/share/ankify-ai}" \
  ANKI_ADDONS_DIR="${ANKI_ADDONS_DIR:-}" \
    bash "$ANKIFY_TOOLS_DIR/install.sh" || echo "    ankify  install.sh 执行失败（非致命）"
else
  echo "    ankify  skipped (no $ANKIFY_TOOLS_DIR/install.sh)"
fi
