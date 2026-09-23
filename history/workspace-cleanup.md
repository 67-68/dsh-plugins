# History: workspace-cleanup

## 2026-09-23T06:13:18.754Z

- summary: 整理 dsh-plugins 工作区：删除重复快照与无关文件，模块化归位，计划审批后执行

## 用户原话

尝试这三个工具，我给你权限了

## Agent 理解

用户要对 dsh-plugins 工作区做整洁架构整理：核心是删除三类杂质——①与真理源完全重复的 `#/` 快照（含本机绝对路径 symlink，install.sh 零引用）；②跨领域误入文件（Anki 制卡 temp、校园网 srun-deliverable、2.2MB 系统崩溃转储、空 addons21）；③已失效副本与运行时污染（已抽离到 ankify_tools 的 plans/ankify-ai、被现行设计取代的 legacy、mode-gate 狗食自产的 features/history、旧命名残留）。然后把剩余设计文档模块化归位（plans→docs/plans，plugins/extensions 二选一处理），更新 README 与 .gitignore 做防污染，最后验证并一次性提交。计划先行、审批后执行，全程 git rm/mv 可回滚，install.sh 零路径变更。

## 用户可见行为

整理后仓库根只剩真理源模块：plugins 仅 host-plane、packages 7 个双面包插件、presets、preset-actions、profile、document、去重后的 feature_intents、scripts、patches、docs/plans；重复快照与无关文件全部消失；.gitignore 新增防污染项；README 目录树更新；bash -n 与抽查 node --check 通过；一次性 chore 提交待推送。

## 功能意图

dsh-plugins 工作区去重去污、模块化归位，恢复真理源纯净结构。

## Checklist

- [ ] 重复快照清理：`#/`（19 个跟踪文件）与空 `addons21/` 删除，运行时日志实体清理
- [ ] 跨领域杂质清理：`temp`、`srun-deliverable` + `plans/srun-auto-login.md`、`issues 9.11.json`（2.2MB）删除
- [ ] 失效副本清理：`plans/ankify-ai/`、`plans/legacy-mode-gate/`、`mode-gate.legacy.md` 删除
- [ ] 运行时污染治理：`features/`、`features.md`、`history/`、overview 占位与双下划线残留删除；`.gitignore` 追加防污染项；断链 symlink 与 `.gitkeep` 清理
- [ ] 模块化归位：`plugins/extensions` 按审批选 A 迁顶层或 B 删除；`plans/` 余下 6 文档迁 `docs/plans/`；`README` 目录树更新
- [ ] 验证与提交：`bash -n` 与抽查 `node --check` 通过，最终树核对，一次性 `chore(cleanup)` 提交待推送
