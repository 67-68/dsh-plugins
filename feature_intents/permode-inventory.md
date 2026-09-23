# per-mode 插件清单 (permode-inventory)

展示「每个 agent preset（模式）挂载了哪些插件」的只读 Web 清单。它是 host 层插件清单（内置 `dsh-host-plugin-inventory` / `dsh-client-ui-settings-plugin-inventory`）在 **preset 层** 的补充。

## 为什么需要

DSH 有两层插件，内置的「插件列表」页面只覆盖了其中一层：

| 层 | 挂载位置 | 内置清单能看到吗 |
| --- | --- | --- |
| host 层（进程级 161 个） | host composition 的 loader entries | ✅ 能（`pluginInventory.list()`） |
| preset 层（每模式一份） | 每个 preset 的 `agent.cordis.yml`，per-session 挂载、进 isolate realm | ❌ **不能** |

preset 的插件行不在 `ctx.loader.entries()` 里，所以「某个模式到底装了哪些工具/服务」目前没有任何 UI 可见。本模块补上这个缺口。

## 功能

- **列出每个 preset 的插件行**：从 `agent.cordis.yml` 提取每行 `{id, name, disabled}`。
- **展示 preset 身份与健康**：`id` / `name` / `description` / `trust`（`system`=部署自带 / `user`=本地自建）/ `broken`（能不能 mount）。
- **默认展示范围**：白名单 `architect` / `g-chat` / `cordis-architect` / `code`，通过 host 插件 config 可改。
- **只读定位**：不改 preset。编辑 preset 仍是 preset 编辑器的职责。

## 数据源与边界

- 数据源是 `agentPresets` 服务的 `list()`（返回 `AgentPreset[]`，含 id/name/trust/broken/path）与 `read(id)`（返回 `agent.cordis.yml` 原文）。
- `read(id)` 只给原文，不返回解析后的行，所以插件自己从 YAML 顶层 list 提取每行的 id/name/disabled。
- 本模块**只管 preset 层**。host 层的启停/安装/健康检查由 `dsh-web-plugin-manager` 负责，两者数据源、落点、生命周期完全不同，不得合并。
