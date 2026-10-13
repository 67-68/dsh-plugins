# workspace-cleanup

## Project Overview

dsh-plugins 是 DeepSeek Harness（DSH）整套配置的真理源 git 仓库：plugins/packages/presets/preset-actions/profile/document 为部署源，install.sh 幂等同步到 ~/.dsh，feature_intents 为唯一规范的需求意图目录。

---

## 2026-09-23T06:13:13.033Z

### 用户原话

尝试这三个工具，我给你权限了

### Agent 理解

用户要对 dsh-plugins 工作区做整洁架构整理：核心是删除三类杂质——①与真理源完全重复的 `#/` 快照（含本机绝对路径 symlink，install.sh 零引用）；②跨领域误入文件（Anki 制卡 temp、校园网 srun-deliverable、2.2MB 系统崩溃转储、空 addons21）；③已失效副本与运行时污染（已抽离到 ankify_tools 的 plans/ankify-ai、被现行设计取代的 legacy、mode-gate 狗食自产的 features/history、旧命名残留）。然后把剩余设计文档模块化归位（plans→docs/plans，plugins/extensions 二选一处理），更新 README 与 .gitignore 做防污染，最后验证并一次性提交。计划先行、审批后执行，全程 git rm/mv 可回滚，install.sh 零路径变更。

### 用户可见行为

整理后仓库根只剩真理源模块：plugins 仅 host-plane、packages 7 个双面包插件、presets、preset-actions、profile、document、去重后的 feature_intents、scripts、patches、docs/plans；重复快照与无关文件全部消失；.gitignore 新增防污染项；README 目录树更新；bash -n 与抽查 node --check 通过；一次性 chore 提交待推送。

### 功能意图

dsh-plugins 工作区去重去污、模块化归位，恢复真理源纯净结构。

### Checklist

- [ ] 重复快照清理：`#/`（19 个跟踪文件）与空 `addons21/` 删除，运行时日志实体清理
- [ ] 跨领域杂质清理：`temp`、`srun-deliverable` + `plans/srun-auto-login.md`、`issues 9.11.json`（2.2MB）删除
- [ ] 失效副本清理：`plans/ankify-ai/`、`plans/legacy-mode-gate/`、`mode-gate.legacy.md` 删除
- [ ] 运行时污染治理：`features/`、`features.md`、`history/`、overview 占位与双下划线残留删除；`.gitignore` 追加防污染项；断链 symlink 与 `.gitkeep` 清理
- [ ] 模块化归位：`plugins/extensions` 按审批选 A 迁顶层或 B 删除；`plans/` 余下 6 文档迁 `docs/plans/`；`README` 目录树更新
- [ ] 验证与提交：`bash -n` 与抽查 `node --check` 通过，最终树核对，一次性 `chore(cleanup)` 提交待推送

---

## 2026-09-23T12:40:28.305Z

### 用户原话

我的意思不是某个文件，而是按照模块排列，文件放的地方正确，上级的文件夹必然包含下级模块。同时可以拆mode-gate，但是其他三个不要拆，都是无关紧要的插件

拆 1，但是 234 不管。我需要的不是拆分某几个文件，而是确保architecture 正确，文件放的地方正确，上级的文件夹必然包含下级模块

### Agent 理解

用户要的不是为拆而拆：只拆 mode-gate/lib/index.js（4110 行，3300 行巨型 apply），read-url/trajectory/session-converter 与 presets 全部不动。评判标准是 architecture 正确性——上级文件夹必然包含下级模块：下沉的每个模块必须归位到 stores/engine/services 或新增的 tools/gateway 等正确的父目录，不允许越层引用与目录散落；verify-architecture.sh 护栏同步加 containment 检查。

### 用户可见行为

用户感知：mode-gate 包内新增职责清晰的子目录与模块，lib/index.js 变薄但插件行为零变化；跑护栏脚本可见新增的归位检查项全过；其他包与 preset 原样不动。

### 功能意图

mode-gate host 入口按架构归位：index 只装配，功能模块全部落进正确的父目录

### Checklist

- [ ] mode-gate host 入口瘦身：lib/index.js 只剩装配，工具注册与钩子按域下沉到子模块
- [ ] arch-containment 归位：每个下沉模块都落在正确的父目录下（tools/gateway/engine 复用），无越层、无散落，护栏规则同步更新

---

## 2026-09-23T12:43:06.561Z

### 用户原话

我的意思不是某个文件，而是按照模块排列，文件放的地方正确，上级的文件夹必然包含下级模块。同时可以拆mode-gate，但是其他三个不要拆，都是无关紧要的插件

拆 1，但是 234 不管。我需要的不是拆分某几个文件，而是确保architecture 正确，文件放的地方正确，上级的文件夹必然包含下级模块

btw，几个模块都在用的工具函数之类的东西需要提升到inter-module 的级别，或者说他们自己就是一个被依赖得比较多的module

### Agent 理解

只拆 mode-gate/lib/index.js（巨型 apply），其他三插件与 presets 不动。评判标准是 architecture 正确性：上级文件夹必然包含下级模块，下沉模块归位到正确的父目录；多模块共用的工具函数上浮为 inter-module 级共享模块（依赖方向单向：业务模块依赖共享层，共享层不反向依赖）；护栏同步加 containment 与共享层检查。

### 用户可见行为

mode-gate包内新增职责清晰的子目录与共享模块，index变薄但插件行为零变化；护栏新增归位与共享层检查全过；其他包与preset原样不动。

### 功能意图

mode-gate host入口按架构归位：index只装配，子模块落位正确父目录，共享工具上浮为公共模块

### Checklist

- [ ] mode-gate host 入口瘦身：lib/index.js 只剩装配，工具注册与钩子按域下沉到子模块
- [ ] arch-containment 归位：每个下沉模块都落在正确的父目录下，无越层、无散落，护栏规则同步更新
- [ ] 共享工具上浮：多模块共用的工具函数提升为 inter-module 级共享模块，被依赖方向单向
