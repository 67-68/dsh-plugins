# mode-gate

## 职责

`dsh-mode-gate` 是一个模式门禁插件，不主动控制工作流，只在 `tools/pre-execute` 上做拦截。

## 概念

- 模式（mode）：`READ_ONLY` / `PLAN_ONLY` / `WRITE_ENABLED` 三种权限档位。
- Target：AI 在行动前必须通过 `declare_target` 声明的当前任务目标；可关联一个预期模式。
- 模式切换：AI 通过 `switch_mode` 请求，用户批准后写入 session log 并生效。

## 规则

- 除 `declare_target` / `switch_mode` / 少量白名单工具外，未声明 Target 的工具调用一律拒绝。
- `READ_ONLY`：仅允许只读工具和只读 bash 命令。
- `PLAN_ONLY`：在 `READ_ONLY` 基础上允许规划类工具。
- `WRITE_ENABLED`：允许写工具；危险 bash 命令仍需人工授权（ask）。
- 状态持久化在插件私有文件 `~/.dsh/mode-gate-state.json`（按 session id 分键）。
  不能写 session log 自定义事件：harness 的持久化读取只认已知事件类型白名单，
  未知且非 `ignorable` 的事件会导致 `SessionFormatUnsupportedError`（历史无法加载）。
  客户端 footer 通过 Remote 服务 `modeGate/getState` 轮询读取该文件。

## 客户端

- Web 设置页提供模式权限展示页签。
- 左侧边栏底部 footer 显示当前模式与已声明的 Target（宽栏显示完整内容，窄栏仅显示模式徽标）。
