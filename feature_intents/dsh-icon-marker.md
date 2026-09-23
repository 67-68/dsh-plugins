# dsh-icon-marker

给 DSH Web 左侧会话列表的每个会话行提供用户可选的 unicode 图标标记，并支持按会话状态与自定义正则规则自动转换图标。

## 为什么需要

DSH 侧栏会话行只有原生状态点（运行中转圈 / 完成绿点 / 等待人工等），没有供用户自定义的语义图标位。用户希望：

- 在标题前手动选择一个 unicode 符号（如 ⭕），hover 能看到符号含义（如「balance 不足」）。
- 能新建自己的符号（一个字符 + 一个含义标签）。
- 能把会话当作 FSM：内置状态（生成中 / 生成完成 / 等待审批 / 等待回答 / 空闲…）自动映射为符号。
- 能用正则规则动态检测当前会话输出与错误内容（如 `balance not enough`），命中后自动给该会话打上对应符号。
- 因为有了自定义图标，可以选择隐藏 DSH 原生的状态点。

## 功能

- **侧栏图标位**：每个会话行标题前渲染一个图标按钮；无符号时显示可点击占位。
- **SymbolPicker**：点击图标位弹出符号下拉列表；每个符号 hover 显示其含义标签；点击即可为该会话手动指定符号；也可清除手动指定。
- **新建符号**：SymbolPicker 内「新建」打开 modal，输入一个 unicode 字符 + hover 含义标签，校验后持久化并自动选中。
- **FSM 状态自动映射**：从 `sessions.list` 解析会话状态（`running` / `completed` / `waitingApproval` / `planReview` / `waitingAnswer` / `subagentsRunning` / `idle`），按设置页配置映射为符号。
- **Regex 自动检测**：设置页维护有序正则规则（`pattern` + `flags` + 符号）；客户端钩子订阅当前打开会话的事件流与错误字段，命中后写入该会话的自动符号状态。
- **隐藏原生状态点**：设置页提供开关，开启后侧栏会话行的 DSH 原生状态点被隐藏。
- **设置页**：包含隐藏状态点开关、FSM 状态映射表、Regex 规则表、自定义符号管理。

## 数据模型

持久化在 settings namespace `dsh-icon-marker`：

```jsonc
{
  "symbols": [          // 用户新增符号
    { "key": "balance-low", "char": "⭕", "label": "balance 不足" }
  ],
  "sessions": {         // 手动指定：sessionId -> symbolKey
    "session-xxx": "balance-low"
  },
  "stateSymbols": {     // FSM 状态 -> symbolKey
    "completed": "done"
  },
  "autoRules": [        // 有序正则规则
    { "id": "r1", "pattern": "balance not enough", "flags": "i", "symbolKey": "balance-low" }
  ],
  "autoSessions": {     // regex 命中后写入的自动状态
    "session-xxx": "balance-low"
  },
  "hideStatus": false
}
```

默认符号硬编码在客户端（避免 settings 数组合并语义导致默认符号被用户层整体替换丢失）。

## 图标解析优先级

手动指定 > regex 自动状态 > FSM 状态映射 > 空占位。

手动指定后，regex 自动状态不得覆盖手动选择。

## 数据源与边界

- 无官方行级 slot：侧栏图标位通过 DOM 注入实现（`MutationObserver` + `requestAnimationFrame`），用 `data-owner` 标记自清理。会话行反查 session id 优先走 React fiber 回溯，回退到标题唯一匹配；无法唯一确定时宁缺毋错。
- FSM 状态直接来自 `ctx.sessions.list` 的会话摘要，覆盖所有已列出会话。
- Regex 钩子只覆盖当前打开的会话（事件窗口已物化的那个）；未打开会话的历史内容不在浏览器内存，不做回溯匹配。
- 原生状态点隐藏仅影响 DOM 呈现，不修改 DSH 状态逻辑。

## 国际化

设置页与 SymbolPicker 提供 zh / en 两套文案。
