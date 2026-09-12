# mode-gate 多工作流配置 Schema 设计

状态：设计定稿（2026-09-12）
适用范围：`packages/dsh-mode-gate` 多工作流改造

## 1. 目标

把 mode-gate 从硬编码的 `PRESET_ACTION -> REQUIREMENT_RECOGNITION -> IMPLEMENT` 单工作流，
改造为**可配置的多工作流状态机**：

- IDLE 为初始/完成态（`kind: "idle"`），用户通过 modal 选择工作流。
- 点击工作流按钮等价于 `/mode <workflowId>`，进入该工作流自己的 `startState`。
- 彻底删除 `IMPLEMENT` 阶段；CREATE 工作流为平级状态循环：
  `BASE_READ -> REQUIREMENT_RECOGNITION -> (RESEARCH -> EXECUTE -> DEBUG -> ACCUMULATION)*n -> IDLE`
- 每个状态的权限、模型（reasoningEffort）、goal、plan、transitions 都由配置声明。

## 2. 文件布局与加载

与 `feature_intents` / `project-experience` 保持一致，**不使用 DOCUMENT 层**：

```
builtin:   packages/dsh-mode-gate/workflows/*.json
global:    ~/.dsh/workflows/*.json
workspace: <workspace>/workflows/*.json

<workspace>/feature_intents/
<workspace>/project-experience/{project}/
```

合并规则：

1. 按 `workflow.id` 合并；workspace > global > builtin。
2. `states` 按 `state.id` 深度合并，避免用户覆盖时重复整份状态。
3. 解析失败必须报错并指出文件，不能静默跳过。
4. 路径在配置中用变量占位（如 `${workspace}`），不写死。

## 3. 顶层 Schema

```json
{
  "version": 1,
  "settings": {
    "idleWorkflow": "IDLE",
    "configSources": ["builtin", "global", "workspace"]
  },
  "workflows": []
}
```

## 4. Workflow 字段

```json
{
  "id": "create",
  "label": "CREATE",
  "description": "写新功能：基准阅读 -> 需求分解 -> 研究/执行/调试/总结循环",
  "kind": "workflow",
  "startState": "BASE_READ",
  "ui": {
    "showInIdleModal": true,
    "order": 20,
    "buttonLabel": "CREATE：写新功能",
    "buttonDescription": "读取项目基准与 feature intent，按 checklist goal 迭代实现"
  },
  "onComplete": { "workflow": "IDLE", "state": "IDLE" },
  "memory": {},
  "staticPlan": {},
  "dynamicPlan": {},
  "states": []
}
```

- `kind`: `idle` | `workflow`
- `kind: "idle"` 表示初始/完成态容器，不显示在 modal 里。
- `onComplete`: 工作流正常结束的默认去向，可被 state transitions 覆盖。

## 5. State 字段（全部平级）

```json
{
  "id": "RESEARCH",
  "label": "研究",
  "description": "重新阅读 project-experience 三个文件，输出实现思路与风险",
  "permissions": {
    "write": false,
    "bash": "read-only",
    "tools": ["skill_load", "skill_search", "bash", "str_replace_editor:view"]
  },
  "model": { "reasoningEffort": "high" },
  "goal": {
    "ref": "create.research",
    "operatesOn": "staticPlan.current"
  },
  "prompt": "……",
  "dynamicPlan": { "enabled": true },
  "transitions": []
}
```

- `permissions.bash`: `none` | `read-only` | `declared` | `unrestricted`
- `permissions.tools`: 可选白名单，`"*"` 表示不限制；`str_replace_editor:view` 表示只读命令。
- `model.reasoningEffort`: `off` | `low` | `high` | `max`；`provider` / `model` 可省略。
- `goal.ref` 引用代码注册表里的内置 goal 实现；`operatesOn` 绑定 plan item。
- 每个 state 只能有一个 active goal。
- 状态进入/退出会触发 dynamicPlan 的清理（见 §6）。

## 6. staticPlan / dynamicPlan / memory

### staticPlan（feature intent 的 checklist -> goals）

```json
{
  "source": "feature-intent.checklist",
  "goalTemplate": {
    "idPrefix": "checklist",
    "acceptance": "$item",
    "status": "pending"
  },
  "enterAt": "REQUIREMENT_RECOGNITION.exit",
  "advanceOn": "ACCUMULATION.exit",
  "completion": "all-goals-completed"
}
```

- 每个 checklist 项 = 一个可验收 goal（如「按钮在 xx 处出现」「点击按钮展示 xxxx 数据」）。
- `REQUIREMENT_RECOGNITION` 完成时解析 checklist 并写入 staticPlan。
- 只有 `staticPlan.pending == 0` 时 CREATE 才允许退出到 IDLE。
- 每个 loop state 通过 `operatesOn: "staticPlan.current"` 作用于当前项。

### dynamicPlan（agent 调研生成的执行计划）

```json
{
  "scope": "state",
  "mirrorTool": "todo_write",
  "allowAgentEdit": true,
  "clearOn": ["state.exit", "goal.completed"]
}
```

- source of truth 在 mode-gate state；`todo_write` 仅作镜像展示（DSH 的 todo projection 每轮 `turn/start` 会 reset，不可作事实源）。
- goal 完成 / 状态切换时清空对应 dynamicPlan。

### memory（REPEAT 循环记忆幂等）

```json
{
  "key": "loopMemory",
  "scope": "workflow-instance",
  "enabled": true,
  "injectAtStates": ["RESEARCH", "EXECUTE", "DEBUG", "ACCUMULATION"],
  "stampField": "iteration",
  "compactAt": ["ACCUMULATION.exit"],
  "maxBytes": 8192
}
```

- 由 `systemPrompt.section()` 每次请求重新注入，天然幂等；带 `iteration` 轮次戳。
- `compactAt` 触发 `ctx.compaction.compactNow()` 压历史。
- DSH 配置层不支持自定义 compact 文本；如确需自定义摘要，只能继承 `BasicCompactionEngine` 覆盖 `summarize()`（暂不做）。

## 7. Transitions（结构化条件，不用字符串 eval）

```json
{
  "when": { "type": "staticPlan.pending", "op": ">", "value": 0 },
  "to": { "workflow": "$self", "state": "RESEARCH" },
  "loop": { "increment": "iteration" },
  "complete": false
}
```

条件类型：

| type | 语义 |
|---|---|
| `always` | 无条件 |
| `goal.completed` | 当前 state 的 goal 完成 |
| `goal.failed` | 当前 goal 失败 |
| `staticPlan.pending` | `op` + `value` 比较待完成 checklist 数 |
| `dynamicPlan.pending` | 同上，针对 dynamicPlan |
| `user.approved` | 用户批准了申请 |
| `user.replied` | 用户有回复 |

目标 `to`：

- `{ "workflow": "$self", "state": "..." }` 同工作流
- `{ "workflow": "create", "state": "..." }` 跨工作流
- `{ "workflow": "IDLE", "state": "IDLE" }` 回初始态

## 8. 内置 goal registry（ref）

代码注册表提供实现，配置只引用 id：

- `preset-action.match` / `preset-action.execute`
- `project-experience.dump`
- `feature-intent.read-and-decompose`
- `create.research` / `create.execute` / `create.debug` / `create.accumulate`
- 动态 checklist goal：`checklist.<n>`（运行时生成）

## 9. 三个内置工作流示例

### IDLE

```json
{
  "id": "IDLE",
  "label": "完成",
  "kind": "idle",
  "startState": "IDLE",
  "states": [
    {
      "id": "IDLE",
      "label": "空闲",
      "permissions": { "write": true, "bash": "unrestricted", "tools": "*" },
      "model": { "reasoningEffort": "low" },
      "prompt": "当前处于 IDLE 完成态。不要主动调用工具；等待用户选择工作流或输入消息。",
      "transitions": []
    }
  ]
}
```

### SIMPLE-ACTION

```json
{
  "id": "simple-action",
  "label": "SIMPLE-ACTION",
  "kind": "workflow",
  "startState": "PRESET_ACTION",
  "ui": { "showInIdleModal": true, "order": 10, "buttonLabel": "SIMPLE-ACTION：简单工作流执行" },
  "onComplete": { "workflow": "IDLE", "state": "IDLE" },
  "states": [
    {
      "id": "PRESET_ACTION",
      "permissions": { "write": false, "bash": "none", "tools": ["list_preset_actions", "submit_preset_action"] },
      "model": { "reasoningEffort": "low" },
      "goal": { "ref": "preset-action.match" },
      "transitions": [
        { "when": { "type": "goal.completed" }, "to": { "workflow": "$self", "state": "ACTION_EXECUTE" } }
      ]
    },
    {
      "id": "ACTION_EXECUTE",
      "permissions": { "write": true, "bash": "declared" },
      "model": { "reasoningEffort": "low" },
      "goal": { "ref": "preset-action.execute" },
      "prompt": "按注入的 preset action skill 执行，不要扩大范围。",
      "transitions": [
        { "when": { "type": "goal.completed" }, "to": { "workflow": "IDLE", "state": "IDLE" } }
      ]
    }
  ]
}
```

### CREATE

见 §4-§7 的组合；完整示例以 `workflows/create.json` 为准（实现阶段落地）。

## 10. 已定决策

1. 配置文件路径不加 DOCUMENT 层，与 feature_intents / project-experience 一致。
2. `IDLE` 用 `kind: "idle"`。
3. transitions 条件使用结构化对象。
4. dynamicPlan source of truth 在 mode-gate state。
5. loopMemory 采用「mode-gate 每轮注入 + 可选 compactNow」，不自定义 compaction 摘要。
6. IDLE 后端不限制，modal 遮罩纯 UI。

## 11. mode-gate 持久化 state v2 与迁移

落盘文件：`~/.dsh/mode-gate-state.json`

### 11.1 顶层形状

```json
{
  "version": 2,
  "sessions": {},
  "bashDenyList": [],
  "modelCatalog": [],
  "taskModes": {},
  "workflowRegistryVersion": 1
}
```

`bashDenyList` / `modelCatalog` / `taskModes` 保持原样，不迁移。

### 11.2 session entry 形状

```json
{
  "workflowId": "create",
  "phase": "RESEARCH",
  "mode": "RESEARCH",
  "target": { "target": "实现 xxx", "mode": "RESEARCH" },
  "skills": ["project-experience"],
  "bash": ["ls", "cat", "grep"],
  "goal": {
    "id": "create.research",
    "status": "active",
    "startedAt": 0,
    "calls": {},
    "iteration": 1,
    "operatesOn": "checklist-2"
  },
  "staticPlan": {
    "source": "feature-intent.checklist",
    "featureIntentFile": "mode-gate",
    "items": [
      { "id": "checklist-1", "text": "按钮出现在 xx 处", "status": "completed", "completedAt": 0 },
      { "id": "checklist-2", "text": "点击按钮展示 xxxx 数据", "status": "in_progress" }
    ],
    "currentId": "checklist-2",
    "createdAt": 0
  },
  "dynamicPlan": {
    "scope": "state",
    "stateId": "EXECUTE",
    "items": [ { "id": "d1", "content": "……", "status": "pending" } ],
    "updatedAt": 0
  },
  "loopMemory": {
    "iteration": 1,
    "blocks": [ { "key": "topology", "text": "……", "stampedAt": 0 } ],
    "updatedAt": 0
  },
  "selectedModel": { "provider": "deepseek-official", "model": "deepseek-v4-pro", "reasoningEffort": "high" },
  "featureIntentFile": "mode-gate",
  "taskMode": "complex",
  "requirementSummary": "……",
  "chosenPresetAction": null,
  "migrationNotice": null
}
```

字段说明：

- `workflowId`: 当前工作流；IDLE 时为 `"IDLE"`。
- `phase`: 当前平级状态 id。
- `mode`: 旧字段镜像，保留给未升级的读取方（客户端旧版本、settings 页）。
- `goal.iteration`: REPEAT 循环轮次，ACCUMULATION 退出时 +1。
- `goal.operatesOn`: 当前 goal 绑定的 checklist item id。
- `staticPlan`: checklist 解析结果，唯一事实源。
- `dynamicPlan`: 当前 state 的动态计划，退出/完成时清空。
- `loopMemory`: REPEAT 记忆 block（带轮次戳）；由 systemPrompt 每轮注入。
- `migrationNotice`: 迁移产生的提示，展示给用户后清空。

### 11.3 新会话默认值

- 没有 session entry 时：`{ workflowId: "IDLE", phase: "IDLE", target: null, goal: null }`。
- IDLE 不限制工具（用户已拍板），`declare_target` 可省略。
- 用户点击工作流按钮 / `/mode <id>` 时：写 `workflowId` + `phase = startState`，但不激活 goal。
- 下一次 `declare_target` 时激活该 startState 的 goal（保持「先 declare_target」契约）。

### 11.4 旧 state 迁移（v1 -> v2）

惰性迁移：读取时在内存里转换，首次写回时才落盘，避免破坏原文件。

| 旧值 | 新值 |
|---|---|
| 无 `workflowId` | 按下表由 `phase`/`mode` 推导 |
| `PRESET_ACTION` | `workflowId: simple-action`, `phase: PRESET_ACTION` |
| `REQUIREMENT_RECOGNITION` | `workflowId: create`, `phase: REQUIREMENT_RECOGNITION` |
| `IMPLEMENT` | `workflowId: IDLE`, `phase: IDLE`, `migrationNotice` 提示旧实现态已终止，请重新选择 CREATE |
| `goal` | 原样保留，补 `iteration: 0` |
| `target/skills/bash/selectedModel/featureIntentFile/taskMode/requirementSummary/chosenPresetAction` | 原样保留 |
| `staticPlan/dynamicPlan/loopMemory` | 缺失时初始化为空结构 |

**IMPLEMENT 迁移的取舍：** 旧 IMPLEMENT 会话没有 checklist，硬塞进 CREATE/EXECUTE 会因为
`staticPlan.current` 为空而无法推进。默认迁到 IDLE 并在提示里说明，是更诚实、不会伪造计划的做法。
如果后续发现需要保活，再加一个可配置项把 `requirementSummary` 压成单条 checklist。

### 11.5 迁移不改的东西

- 不做全量重写：`loadStateStore()` 只在内存转换，`saveStateStore()` 才带 `version: 2` 写回。
- 旧客户端读取 `mode` 字段仍然可用。
- `bashDenyList` 等全局配置零迁移。
