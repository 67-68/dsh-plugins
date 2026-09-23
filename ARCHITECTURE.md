# ARCHITECTURE

仓库是 source of truth，`./install.sh` 幂等部署到 `$DSH_HOME`（默认 `~/.dsh`）。
护栏：`scripts/verify-architecture.sh`（本文件每条规则都有对应检查）。

## 目录地图

```text
install.sh + install/lib/*.sh   # 部署流水线（env/guard-*/sync-*/build-mermaid）
profile/cordis.patch.yml        # 唯一 profile patch，symlink 进 profiles/web/
plugins/*.mjs                   # host 插件，symlink 进 profiles/web/
presets/                        # preset 源，整目录实拷贝进 .agent-presets/
preset-actions/                 # preset-action 源，diff 变更才覆盖
packages/*/lib/                 # 双面/单面 npm 包，整目录实拷贝进 profiles/node_modules/
extensions/                     # 第三方 bundle，解压即用
document/                       # 运行时文档 → $DSH_HOME/DOCUMENT/（symlink）
docs/plans/                     # 设计文档，不部署
feature_intents/                # 模块意图（项目文件，不进部署）
scripts/                        # 运维脚本（含本护栏）
```

## 包骨架（规则 1）

每个 `packages/*/` 必须有 `package.json`（`main` 指向 `lib/` 内）+ `lib/`。
例外白名单：`LICENSE`；`dsh-mode-gate/workflows/`；`dsh-trajectory-notes/scripts/`。
包根禁止散落 `*.js`。

## mode-gate 分层（规则 2）

`packages/dsh-mode-gate/lib/` 顶层只允许 `index.js`（唯一入口）+ `client.js`
（浏览器面，零导入）。业务按职责分三层：

- `stores/` — 持久化存储（intent/tree/list、pattern、journal、history、architecture、restrictions）
- `engine/` — 工作流引擎（goals、transitions、state、permissions、plans、protocols、workflows、bash、dependency-map、goal-engine）
- `services/` — 横切服务（context、compression、text-limits、pattern-gate、journal-guard、git-*）

`workflows.js` 内 `BUILTIN_WORKFLOW_DIR` 必须与包内 `workflows/` 目录保持同包。

## 阶段命令 Set（规则 2b）

每个阶段一套命令 Set，声明「阶段启动即注入并 tool-search 优先放行」的命令：

- 定义：`packages/dsh-mode-gate/lib/stores/restrictions.js` 的 `BUILTIN_STAGE_COMMAND_SETS`，
  按 `<workflowId>.<stateId>` 索引（如 `create.REQUIREMENT_RECOGNITION`）。
- 内容：`initialCommands` = 该阶段 goal 的 requiredCalls + submitTool 中「阶段专属」部分；
  通用的 `submit_state` / `switch_mode` 由 `ALWAYS_ALLOWED` 兜底，不进 Set。
- Universal：`todo_write` / `submit_state` 每阶段注入（`DEFAULT_UNIVERSAL_COMMANDS`），
  由限制套件 `universalCommands` 覆盖。
- 消费：`index.js` 的 `stageCommandSetFor` / `stageInjectedCommands`；注入进 policy 文本 +
  scope 供给，并在 `tools/pre-execute` 的 tool-search 白名单优先与注入白名单处生效。
- 阶段×命令依赖表来源：各 workflow JSON 的 `states[].permissions.tools` 与
  `engine/goals.js` 的 `requiredCalls` / `submitTool`。

## 依赖方向（规则 3）

- 禁止跨包引用：`packages/A` 的代码不得 import `packages/B`。
- 禁止逃逸引用：相对 import 解析后不得超出本包目录。
- 包之间只通过 DSH 运行时（ctx / services / Remote）通信，不直接 import。

## 路径可移植（规则 4）

`profile/`、`install/`、`plugins/`、`packages/`、`presets/`、`preset-actions/`、
`extensions/` 内禁止本机绝对路径（`/Users/`、`/home/`）。用户家目录一律写
`~`（消费端负责展开），部署根用 `$DSH_HOME`（缺省回落 `~/.dsh`）。

## 文档边界（规则 5）

`document/`（部署到 DOCUMENT 的运行时 skill）与 `docs/plans/`（设计）禁止同名文件。
改名设计侧（运行时文件名被 intent/skill 引用，不能动），并互相头注指路。

## 构建与归档（规则 6）

- `temp/` 构建缓存目录（gitignored）：构建脚本先输出到 `temp/`，再按内容变化同步交付物。
- `scripts/` 顶层只留 `build-mermaid.mjs`（构建）+ `verify-architecture.sh`（护栏）+ `archive/`（一次性脚本归档）。
- `extensions/` 目录名不带版本号（版本在 manifest 内）。
- `docs/INDEX.md` 为意图与计划索引（`features.md` 活表由 mode-gate 拥有，不手改）。
