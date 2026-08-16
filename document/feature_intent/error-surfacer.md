# 错误呈现 (error-surfacer)

让「浏览器报错」和「插件启动报错」从「看不到」变成「可见 + 可定位 + 可隔离」。

## 为什么需要

DSH 有两类报错目前对 agent 和用户基本不可见：

| 报错类型 | 出现位置 | 现在谁看得到 |
| --- | --- | --- |
| 浏览器页面运行时错误（`error` / `unhandledrejection`） | 浏览器页面上 | 只有用户开 F12 Console 才看得到；agent 完全拿不到 |
| 启动期插件报错（`entries did not activate` / `fatal load failure` / `failed to apply loader entry`） | `dsh web` 终端 stderr | 只有启动者翻终端才看得到；会话内 agent 看不到 |

本模块补上「错误呈现」这一层：host 工具让 agent 自查，client 悬浮面板让页面直接展示，skill 教 agent 怎么定位。

## 功能

- **host 工具 `browser_errors`**：`list` 读环形缓冲快照，`clear` 清空。
- **host Remote 服务 `errorSurfacer`**（Typert Remote）：`report(error)` 追加、`clear()` 清空，client 通过 `remote.errorSurfacer` 调用。
- **client 悬浮面板**（`shell.overlay` slot，id `error-surfacer`）：右下角「报错 N」徽标，点击展开列表（message/stack/时间），一键清空本地 + 远端。
- **skill `browser-error-diagnostics`**（`source: 'runtime'`）：教 agent 何时查、怎么查、怎么定位启动期插件报错、怎么用 disabled 隔离。

## 数据流与边界

- client 用 `window.addEventListener('error' / 'unhandledrejection')` 捕获，转成最小 JSON `{source, message, stack, timestamp}` 后 (a) 进本地 React 状态渲染，(b) 经 Remote `report` 推到 host 环形缓冲。
- host 环形缓冲只存标量最小 JSON 错误对象 `{id, source, message, stack, timestamp}`，上限 200 条（可选 `config.maxEntries` 覆盖），超出丢最旧；绝不存 DSH/Cordis 活对象。
- 一切副作用可逆：Remote 挂载、window 事件监听、tool/skill 注册、slot 注册都通过 `ctx.effect` / disposer 包住，stop/update/卸载时清理。

## 约束（本模块不做什么）

- **不吞启动报错**：host composition 层的插件报错依然会让 `dsh web` 起不来（bootstrap 的 fail-fast 语义，本模块不改变它）。本模块只负责让报错「可见 + 可定位 + 可用 disabled 隔离」。
- 不改 bootstrap / `assertEntriesActivated` 等启动逻辑。
- 只做「呈现 + 定位」，不自动修复任何插件。
