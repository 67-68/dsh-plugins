# dsh-icon-marker 实施计划

> 状态：已确认方案，待 code 模式执行。
> 目标：新建本地双面包插件 `dsh-icon-marker`，为侧栏会话行提供 unicode 图标标记 + 自动状态转换 + 隐藏原生状态点。

## 1. 已确认决策

| 项 | 结论 |
|---|---|
| auto 状态作用域 | per-session：`autoSessions[sessionId] = symbolKey` |
| 图标优先级 | 手动 > regex 自动 > FSM 状态自动 > 空占位 |
| 手动选择后 regex 是否覆盖 | 不覆盖 |
| 自动转换形态 | 内置 FSM 状态表 + 自定义 regex 规则都做 |
| regex 钩子首版范围 | 只覆盖当前打开的会话（`.events` 已物化的那个） |
| 隐藏原生状态点 | 设置页 toggle，默认关闭（不隐藏） |
| 持久化 | settings namespace `dsh-icon-marker`（宿主注册 schema，客户端 `settingsScope` 读写） |

## 2. 文件布局

```
packages/dsh-icon-marker/
├── package.json
└── lib/
    ├── index.js      # 宿主侧：注册 settings namespace
    └── client.js     # 浏览器侧：设置页 + SymbolPicker + DOM 注入 + regex 钩子
profile/cordis.patch.yml  # 增补一行 - id: icon-marker / name: 'dsh-icon-marker'
document/feature_intent/dsh-icon-marker.md  # 模块意图文档
```

## 3. 数据模型（settings namespace `dsh-icon-marker`）

```jsonc
{
  "symbols": [                     // 用户新增符号（默认符号硬编码在客户端）
    { "key": "balance-low", "char": "⭕", "label": "balance 不足" }
  ],
  "sessions": {                    // 手动指定
    "session-xxx": "balance-low"
  },
  "stateSymbols": {                // 内置 FSM 状态 -> 符号 key
    "running": "running",
    "completed": "done"
  },
  "autoRules": [                   // 有序 regex 规则
    { "id": "r1", "pattern": "balance not enough", "flags": "i", "symbolKey": "balance-low" }
  ],
  "autoSessions": {                // regex 钩子命中后写入
    "session-xxx": "balance-low"
  },
  "hideStatus": false
}
```

Schema 由宿主侧用 `@deepseek-ai/dsh-settings` + `@deepseek-ai/schemastery` 注册。

## 4. 默认符号（客户端硬编码，用户可新增）

建议首批内置：`⭕ balance 不足`、`💚 生成完成`、`🔴 错误`、`🟡 进行中`、`⭐ 重要`、`📌 已固定`、`✅ 已通过`、`❌ 已拒绝`、`💤 搁置`、`❓ 有疑问`。默认符号不可删除。

## 5. 实施任务（按顺序）

1. **包骨架**：创建 `packages/dsh-icon-marker/package.json`，name `dsh-icon-marker`，`dsh.client.platform = "web"`，`dsh.client.inject` 参考 `dsh-mode-gate`；`main` 指向 `lib/index.js`，`exports` 暴露 `.` 与 `./client`；peerDependencies 声明 `@deepseek-ai/cordis`、`@deepseek-ai/dsh-settings`、`@deepseek-ai/schemastery`、`react`。

2. **宿主侧 `lib/index.js`**：
   - `inject: ['settings']`。
   - 用 `settingsNamespace('dsh-icon-marker')` + `schemastery` 注册 schema：`symbols` / `sessions` / `stateSymbols` / `autoRules` / `autoSessions` / `hideStatus`。
   - 不写业务逻辑。

3. **浏览器侧基础框架 `lib/client.js`**：
   - `window.__ModuleLoader__.load({ id: "dsh-icon-marker", factory })`。
   - `exports.inject = ['slots', 'settingsScope', 'sessions']`（Cordis 服务名）。
   - `apply(ctx)` 中 `ctx.settingsScope.bind({ namespace: 'dsh-icon-marker' })`，保存 `scopeRef` / `sessionsRef`。
   - 订阅 `scope.subscribe` 与 `sessions.list.subscribe`，驱动 `renderAll()`。

4. **SymbolPicker + 新建 Modal**：
   - 纯 DOM 弹出层（不依赖 React 渲染到 sidebar）。
   - 符号网格；每个符号用 `title` 显示 label（hover 可见）。
   - 「新建」按钮打开 modal：输入一个 unicode 字符 + label；校验单字符、label 非空、key 自动生成。
   - 写入 `settingsScope` 后触发 `renderAll()`。

5. **Sidebar DOM 注入**：
   - `MutationObserver` 观察 `document.body`，`requestAnimationFrame` 节流。
   - 识别会话行：`[role="treeitem"]` 且能找到标题 span；优先用 React fiber 向上回溯取精确 `node.id`，回退到标题唯一匹配；标题重复且无 fiber 信息时跳过（宁缺毋错）。
   - 在标题 span 前插入一个 `data-owner="dsh-icon-marker"` 的图标按钮；点击 `stopPropagation`，打开 SymbolPicker。
   - 图标内容按优先级解析：`sessions[sid]` > `autoSessions[sid]` > `stateSymbols[fsm(sid)]` > 占位符。
   - 若 `hideStatus === true`，隐藏该行原生状态 slot。

6. **FSM 状态解析**：
   - 从 `sessions.list.getSnapshot().byId[sid]` 计算状态：`running` / `completed` / `waitingApproval` / `planReview` / `waitingAnswer` / `subagentsRunning` / `idle`。
   - 查 `stateSymbols` 得到符号；无映射则回退。

7. **Regex 自动钩子（当前打开会话）**：
   - 监听 `sessions.list`，当 `current` 变化时，`sessions.binding(current)?.session.subscribe(...)`。
   - 在订阅回调中读取 `session.getSnapshot()` 的 `lastAgentError` / `promptError`；同时扫描 `session.events` 中 `seq > lastSeenSeq` 的新事件。
   - 文本抽取覆盖：`assistant/message`（`content` 中 `text` 块）、`text-chunks`、错误字段。
   - 按 `autoRules` 顺序跑 `new RegExp(pattern, flags)`；命中后写 `autoSessions[sessionId] = rule.symbolKey`（只在没有手动 `sessions[sessionId]` 时写）；无命中保持现状。
   - 维护 `lastSeenSeq` 避免重复扫描；切会话时重置。

8. **设置页**：
   - `ctx.slots.inject("settings.section", ...)`，id `icon-marker`。
   - React 组件（用 `react` 与内联样式）：
     a. 「隐藏 DSH 原生状态点」toggle。
     b. FSM 状态映射表：每个状态行右侧一个可点击符号位，点击打开 SymbolPicker。
     c. Regex 规则表：可增删规则，每条 `pattern` + `flags` + 符号位；点击符号位打开 SymbolPicker。
     d. 自定义符号列表：新增/删除（删除仅限非默认符号）。
   - 所有设置变更走 `scopeRef.scope.set/unset`。

9. **接入 composition**：
   - `profile/cordis.patch.yml` 在 `dsh-mermaid` 后增补：
     ```yaml
     - id: icon-marker
       name: 'dsh-icon-marker'
       config: {}
     ```

10. **测试与验收**：
    - `node --check packages/dsh-icon-marker/lib/index.js` 与 `lib/client.js` 语法检查。
    - `./install.sh` 同步。
    - 重启 `dsh web`，验证：
      - 侧栏会话行出现图标占位/已选符号；hover 显示 label。
      - 点击弹出符号下拉；新建符号 modal 可创建并自动选中。
      - 设置页 toggle 可隐藏原生状态点。
      - 设置页 FSM 表可给「生成完成」配 💚。
      - 设置页 regex 规则 `balance not enough` → ⭕；触发一次带该文本的输出/错误后，当前会话自动变 ⭕。
      - 手动选择后 regex 不覆盖。

11. **文档与提交**：
    - 更新 `document/feature_intent/dsh-icon-marker.md`（模块意图，不写计划）。
    - 提交 commit。
    - 若未来改动 csv/云端配置，再另行同步。

## 6. 关键边界与风险

- **无官方行级 slot**：必须 DOM 注入；DSH 大改列表 DOM 时选择器可能失效。用 fiber 取 session id 降低误判，但要容忍未来失效。
- **regex 钩子只覆盖当前打开会话**：未打开会话的历史输出无法回溯匹配；后续如需全量扫描，要加宿主侧 session log 扫描，另开二期。
- **原生状态点隐藏**：只影响 DOM 显示，不动 DSH 内部逻辑；状态点被我们隐藏后，图标仍可表达状态。
- **默认符号硬编码**：与 `dsh-session-status` 内置三态同理，避免 settings mergeLayers 数组整体替换导致默认符号丢失。
