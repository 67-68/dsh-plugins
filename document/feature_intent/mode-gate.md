# mode-gate

## 职责

`dsh-mode-gate` 是一个模式门禁插件，不主动控制工作流，只在 `tools/pre-execute` 上做拦截。

## 概念

- 模式（mode）：`READ_ONLY` / `PLAN_ONLY` / `WRITE_ENABLED` 三种权限档位。
- Target：AI 在行动前必须通过 `declare_target` 声明的当前任务目标；可关联一个预期模式。
- 能力声明：`declare_target` 同时声明本次需要的 `skills` 和 `bash` 命令动词；未声明即被拦截。
- 额外申请：`request_extra` 无参时查看当前能力，带参时作为问题向用户申报，批准后追加到当前 session。
- bash 禁止列表（deny-list）：全局生效，命中即拒绝；默认禁止 `curl` / `wget`，网页阅读统一走 `read_url` 系列工具。
- 模式切换：AI 通过 `switch_mode` 请求，用户批准后生效；切换模式不重置已声明的 skills/bash。

## 规则

- 除 `declare_target` / `switch_mode` / `skill_search` / `request_extra` / 少量白名单工具外，未声明 Target 的工具调用一律拒绝。
- `READ_ONLY`：仅允许只读工具和只读 bash 命令；`str_replace_editor` 仅放行 `view`。
- `PLAN_ONLY`：在 `READ_ONLY` 基础上允许规划类工具。
- `WRITE_ENABLED`：允许写工具；危险 bash 命令仍需人工授权（ask）。
- `skill_load` 只放行当前 session 已声明的 skill；`skill_search` 始终放行。
- bash 命令按管道/分隔符切分后逐段检查首动词：先匹配禁止列表，再按模式做安全分类，最后检查是否在已声明 bash 动词内。
- 模式特有 prompt 由 `systemPrompt.section` 按当前 mode 动态生成，包含当前禁止列表与已声明能力。
- 状态持久化在插件私有文件 `~/.dsh/mode-gate-state.json`（按 session id 分键，禁止列表存顶层 `bashDenyList`）。
  不能写 session log 自定义事件：harness 的持久化读取只认已知事件类型白名单，
  未知且非 `ignorable` 的事件会导致 `SessionFormatUnsupportedError`（历史无法加载）。
  客户端 footer 通过 Remote 服务 `modeGate/getState` 轮询读取该文件。

## 客户端

- Web 设置页提供模式权限展示页签，并维护 bash 禁止列表（命令 + 原因，可增删改）。
- 左侧边栏底部 footer 显示当前模式与已声明的 Target（宽栏显示完整内容，窄栏仅显示模式徽标）。
