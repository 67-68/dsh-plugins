#!/usr/bin/env bash
# Deploy dsh-plugins into the running DSH home via symlinks.
# Edits in this repo become live after a `dsh web` restart (web HMR is off).
#
# Usage:
#   ./install.sh            # deploy to ${DSH_HOME:-$HOME/.dsh}
#   ./install.sh /path      # deploy to a specific DSH home
#
# 瘦入口：只做参数解析与模块编排，具体逻辑在 install/lib/ 下按职责分文件。
# 各模块由 source 在同一 shell 执行，共享 set 选项与目录变量，行为与拆分前一致。

set -euo pipefail

DSH_HOME="${1:-${DSH_HOME:-$HOME/.dsh}}"
HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
LIB="$HERE/install/lib"

# shellcheck disable=SC1090,SC1091
source "$LIB/env.sh"                  # 目录变量 + 目标目录预建

source "$LIB/guard-profile-version.sh"  # 0)  profile package.json 缺 version 补写
source "$LIB/guard-bash-histexpand.sh"  # 0b) persistent bash 卡住修复
source "$LIB/guard-opencode-models.sh"  # 0c) opencode-go 模型目录覆盖
source "$LIB/guard-opencode-session.sh" # 0d) opencode-go 会话头兼容
source "$LIB/guard-compaction.sh"       # 0e) host plane compaction 覆盖守护

echo "==> Deploying dsh-plugins -> $DSH_HOME"

source "$LIB/sync-plugins.sh"         # 1)  host plugins symlink
source "$LIB/sync-profile.sh"         # 2)  cordis.patch.yml symlink
source "$LIB/sync-ankify.sh"          # 3b) ankify  sibling 委托（非致命）
source "$LIB/sync-presets.sh"         # 3)  presets 真实目录拷贝
source "$LIB/sync-preset-actions.sh"  # 3c) preset actions 真实目录拷贝
source "$LIB/sync-docs.sh"            # 4)  document symlink
source "$LIB/build-mermaid.sh"        # 4b) mermaid 产物缺失时构建
source "$LIB/sync-packages.sh"        # 5)  本地双面包插件拷贝
source "$LIB/sync-external.sh"        # 6)  外部插件声明安装

echo "==> Done. Restart 'dsh web' to apply changes."
