# mode-gate

## 职责

`dsh-mode-gate` 是一个协议驱动的需求循环门禁插件。它不只按权限档位拦截工具，而是强制 agent 在开始实现前完成一段可配置、可延展的目标序列：preset-action 探测 -> 需求识别（读/追加 feature intent + 提交协议）-> 实现。

## 阶段

- `PRESET_ACTION`：在需求分解之前探测是否存在匹配的 preset action。agent 必须调用 `list_preset_actions` 查看候选 skill，再调用 `submit_preset_action` 提交探测协议。未命中（或探测失败）直接进入 `REQUIREMENT_RECOGNITION`；命中则注入该 skill 内容并直接进入 `IMPLEMENT`，跳过需求分解。
- `REQUIREMENT_RECOGNITION`：合并原 `READ_ONLY` 与 `PLAN_ONLY` 的权限，并绑定两个目标：先至少阅读一个 feature intent，再至少追加一条 feature intent 记录并提交 `submit_requirement_protocol` 协议。协议校验通过后自动进入 `IMPLEMENT`，校验失败作为工具错误打回重试。
- `IMPLEMENT`：替代原 `WRITE_ENABLED`。可写，但 feature_intent 目录仍禁止直接修改。

## 目标系统（goal engine）

- 每个目标定义包含：`id`、`phase`、`prompt`、`allowedTools`、`allowedBash`、`requiredCalls`、`submitTool`、`onActivate` / `onSubmit` / `onComplete`。
- 目标激活时执行 `onActivate`：可注入 prompt、追加消息、写状态；例如 `feature-intent-read` 激活时自动读取一个 feature intent 并注入内容。
- 目标未完成时，`tools/pre-execute` 只放行 `allowedTools` 与少数控制工具；bash 默认禁用。
- 目标完成条件：满足 `requiredCalls`（指定工具至少调用过 N 次）+ 提交协议通过自定义 parser。无 `submitTool` 的目标在 `requiredCalls` 满足后自动完成并进入下一目标。
- 目标系统是 mode-gate 内的可复用模块，新增目标只需按定义对象扩展。

## 协议

两个专用提交工具承载协议，校验失败直接返回工具错误：

- `submit_preset_action`：`{ skill_id }`（命中）或 `{ no_match: true }`（未命中）。
- `submit_requirement_protocol`：`{ protocol, version, task_mode, model_override?, feature_intent_file, summary }`。`task_mode` 为 `simple` / `complex`；`model_override` 可覆盖任务模式默认模型；模型必须存在于用户可编辑的模型目录中。

## feature intent 存储与工具

- 目录：由插件 config `featureIntentDir` 指定（当前工作区绝对路径 `/Users/a67_68/projects/documentation/feature_intents`）。
- `list_feature_intents`：列出目录下所有 intent 文件；两个阶段都可用。
- `get_feature_intent`：读取指定 intent；两个阶段都可用。
- `update_feature_intent`：只在 `REQUIREMENT_RECOGNITION` 可用；只追加日志式记录，不重写。文件不存在时创建，且必须填写 `project_overview`。
- agent 禁止直接修改 feature intent 文件：写工具参数中命中 feature_intent 目录一律拒绝；bash 命令命中目录且为写入/危险分类时拒绝。

## preset action skill

- 存放：仓库 `preset-actions/<id>/SKILL.md`，`install.sh` 拷贝到 `~/.dsh/preset-actions/`。
- mode-gate 启动时注册为隐藏 skill（`invocation: { modelInvocable: false, userInvocable: false }`），只有 `list_preset_actions` 能列出。
- SKILL.md 内可包含 `<!-- mode-gate: {...} -->` JSON 元数据：`description`、`match`、`model`、`provider`、`reasoning_effort`；命中后用于模型/思考程度切换。

## 模型目录与切换

- 模型目录（id/name/description/provider）持久化在 mode-gate 状态文件顶层，设置页可增删改，并在需求识别阶段注入 prompt 给 agent。
- 任务模式默认模型：`simple` 默认 `deepseek-v4-flash`，`complex` 默认 `deepseek-v4-pro`；协议 `model_override` 可覆盖。
- 模型切换：优先尝试对当前会话的 `agent/request` 做覆盖；同时保存为默认模型配置。若当前会话未生效，prompt 提示用户手动切换。

## 状态与持久化

- 状态持久化在插件私有文件 `~/.dsh/mode-gate-state.json`（按 session id 分键；`bashDenyList`、`modelCatalog`、`taskModes` 存顶层）。
- 不能写 session log 自定义事件：harness 的持久化读取只认已知事件类型白名单，未知且非 `ignorable` 的事件会导致 `SessionFormatUnsupportedError`（历史无法加载）。
- 客户端 footer 通过 Remote 服务 `modeGate/getState` 轮询读取该文件。

## 客户端

- Web 设置页展示阶段权限、维护模型目录、任务模式默认模型、bash 禁止列表。
- 左侧边栏底部 footer 显示当前阶段与已声明的 Target（宽栏显示完整内容，窄栏仅显示阶段徽标）。
