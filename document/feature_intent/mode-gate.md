# mode-gate

## Project Overview

`dsh-mode-gate` 是 DSH 的会话阶段门禁插件，把对话生命周期建模为一组可配置的工作流状态机。它同时约束 agent 的工具/命令权限、注入每个状态的目标提示、维护 checklist 计划与动态计划，并在工作流结束时把项目经验沉淀到 project-experience。

## 设计意图

- **多工作流，而不是单条硬编码流水线。** 工作流定义放在 JSON 配置里，插件按 `builtin -> global -> workspace` 合并；新增工作流不需要改代码。
- **状态平级，没有隐式的 IMPLEMENT 阶段。** 每个状态自己声明权限、模型、目标与迁移条件。
- **约束即自由。** 状态通过 `permissions` 明确“现在能做什么”，避免 agent 在错误阶段做破坏性操作。
- **可验收的 checklist 驱动循环。** feature intent 里的 checklist 是可验证节点，转换为 staticPlan goals；只有全部完成工作流才算结束。
- **计划分层。** staticPlan 跨状态存在（checklist），dynamicPlan 只在当前状态内有效，状态切换即清空。
- **目标与转义交给引擎，状态与流程交给配置。** goal 负责“当前该干什么”，transitions 负责“完成后去哪”。

## 内置工作流

### IDLE

- 初始/完成态，`kind: "idle"`。
- 后端不限制工具；UI 用 modal 遮住聊天区但保留输入框，右下角/右上角提供显示隐藏控制。
- 用户点击工作流按钮等价于 `/mode <workflowId>`。

### SIMPLE-ACTION

用于“不需要需求分解、命中即执行”的机械任务。

- `PRESET_ACTION`：只允许 `list_preset_actions` / `submit_preset_action`；命中后进入 `ACTION_EXECUTE`，未命中回 IDLE。
- `ACTION_EXECUTE`：可写；按注入的 preset action skill 执行；完成后回 IDLE。

### CREATE

用于写新功能，采用 REPEAT UNTIL 循环，状态全部平级：

```
BASE_READ
  -> REQUIREMENT_RECOGNITION
  -> (RESEARCH -> EXECUTE -> DEBUG -> ACCUMULATION) * n
  -> IDLE
```

- `BASE_READ`（高思考）：用 `read_project_experience` 一次性读取项目基准。
- `REQUIREMENT_RECOGNITION`（高思考）：允许 bash 但禁止写文件；用 `update_feature_intent` 一次写入 `user_words` / `understanding` / `checklist`，提交协议后 checklist 注册为 staticPlan。
- `RESEARCH`（高思考）：重新阅读 project-experience，针对当前 checklist goal 产出实现思路与风险。
- `EXECUTE`（低思考）：执行当前 goal，只做该 goal 范围内的事。
- `DEBUG`（低思考）：验证验收标准；无法自行解决时，必须把复现步骤和需要用户做什么写清楚，请求用户协助。
- `ACCUMULATION`（低思考）：用 `update_project_experience` 沉淀本轮经验；随后推进到下一个 checklist goal，全部完成则回 IDLE。

## 目标系统（goal engine）

- goal 定义：`id`、`prompt(env, state)`、`allowedTools`、`requiredCalls`、`submitTool`、`onActivate` / `onSubmit` / `onComplete`。
- 完成时返回 `{ signal?, statePatch?, prompt? }`，由 index.js 读取状态配置的 transitions 决定下一状态。
- 无 `submitTool` 但有 `requiredCalls` 的 goal 在调用满足后自动完成（例如 `project-experience.dump`）。
- 控制工具始终可用：`declare_target`、`switch_mode`、`skill_search`、`skill_load`、`request_extra`、`dev_tool_search`、`submit_state`。

## 计划（plans）

- `staticPlan`：从 feature intent 的 checklist 解析而来，每项是可验收 goal，带 `pending / in_progress / completed`。
- `dynamicPlan`：agent 在当前状态内的临时计划，由 `todo_write` 镜像，事实源在 mode-gate state；状态切换或 goal 完成时清空。
- `loopMemory`：REPEAT 循环的幂等记忆块，由 systemPrompt 每轮重新注入，带轮次戳；循环边界可触发 `ctx.compaction.compactNow()`。

## project-experience

- 目录：`<workspace>/project-experience/{project}/`，与 feature_intents 同级。
- 文件：`intro.md`、`map-of-content.md`、`anti-patterns.md`、`core-state-tree.md`。
- 创建 feature intent 文件时自动创建项目文件夹与 `intro.md`。
- `read_project_experience` 一次性返回四个文件；`update_project_experience` 支持 `append`（直接写）与 `overwrite` / `diff`（走用户审批）。

## 权限与命令拦截

- 状态声明 `permissions: { write, bash, tools }`；`bash` 取值 `none / read-only / declared / unrestricted`。
- 纯只读简单命令（`ls`、`cat`、`head`、`tail`、`grep`、`find`、`sed -n`、`awk`、`wc`、`sort`、`uniq` 等）在所有状态放行，无需声明；带写入能力的 flag（`sed -i`、`find -exec`、`sort -o`）会被降级为 mutating。
- 危险命令仍需人工授权；`curl` / `wget` 默认禁止。
- feature_intent 目录禁止直接写，只能用 `update_feature_intent` 追加。

## 状态与持久化

- 状态文件 `~/.dsh/mode-gate-state.json`，v2 形状：`workflowId + phase + target + skills + bash + goal + staticPlan + dynamicPlan + loopMemory`。
- 旧 state 惰性迁移：`PRESET_ACTION -> simple-action`、`REQUIREMENT_RECOGNITION -> create`、`IMPLEMENT -> IDLE`（旧实现态无 checklist，迁到 IDLE 并提示）。
- 全局配置（`bashDenyList` / `modelCatalog` / `taskModes`）保持顶层。

## 客户端

- IDLE modal：覆盖聊天区但保留输入框与标题栏；按工作流数量自动生成按钮；右上角有显示/隐藏按钮。
- 输入框 placeholder 在 IDLE 显示“或者你想随便聊点什么？（未来功能：小模型自动路由匹配工作流）”；focus 且有内容时取消遮罩。
- 设置页展示工作流/状态权限，维护模型目录、任务模式默认模型与 bash 禁止列表。
- 左侧 footer 显示当前工作流/状态与 Target。

## 相关

- 配置 schema 与 state v2 设计：`plans/mode-gate-workflow-schema.md`。
- 插件代码：`packages/dsh-mode-gate`；同步：`install.sh`。
