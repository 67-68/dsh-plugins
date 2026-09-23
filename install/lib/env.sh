# install/lib/env.sh — 共享环境：子目录变量、目标目录预建。
# 由 install.sh source 执行（同一 shell），不要直接运行。
# 前置：main 已算好 DSH_HOME（支持 $1 参数）与 HERE（仓库根）。
WEB_DIR="$DSH_HOME/profiles/web"
PRESET_DIR="$DSH_HOME/.agent-presets"
DOC_DIR="$DSH_HOME/DOCUMENT"
NODE_MODULES_DIR="$DSH_HOME/profiles/node_modules"

mkdir -p "$WEB_DIR" "$PRESET_DIR" "$DOC_DIR" "$NODE_MODULES_DIR"
