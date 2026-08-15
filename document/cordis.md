# cordis 模式经验

## 关于「模式 / preset」相关能力的查找备忘

本次会话花了较长时间查找「模式相关的东西」，沉淀如下，避免下次重复：

- agent preset 目录：`~/.dsh/.agent-presets/<id>/`，结构为 `agent.cordis.yml` + `persona.md` + `preset.yml`
- 列出所有 preset：`agentPresets.list()`
- 读某个 preset 的组成文本：`agentPresets.read(id)`
- 当前会话是哪个 preset：`agentPresets.composedPreset(agent.ctx)`（同步方法）
- 克隆一个 preset：`agentPresets.copy(from, id, name?)`
- 默认 preset 在 `~/.dsh/settings.yaml` 的 `agent-presets.default`
- 会话日志 `~/.dsh/sessions/<workspace>/<session>/session.jsonl.zstd` 里的 `agent-preset/selected` 事件记录了实际选中的 preset

## 按模式自动注入经验（本插件的机制）

- 用 `systemPrompt.section({ text: (ctx) => ... })` 实现「会话开始自动插入」，text 是同步函数
- `AssembleContext.agent` 可拿到当前 agent，再 `agentPresets.composedPreset(agent.ctx)` 得到模式名
- section 的 text 是同步的，文件要预先异步读进内存缓存
- skill 是按需加载，`systemPrompt.section` 才是「主动注入」

## 动态插件 vs 持久化

- 动态插件（cordis_define/run）是临时的，进程重启即消失
- 持久化：写进 host composition（全局层，全模式）或某个 preset 目录（仅该模式）
- 注入插件本身若要长期生效，应落到 host composition，而不是动态插件

## 如何注册永久插件（host-plane，本次实测）

- 落点：`~/.dsh/profiles/web/cordis.patch.yml`（用户 patch 层），重启 `dsh web` 生效
- 插件文件放同目录 `~/.dsh/profiles/web/*.mjs`，行内 `name: './xxx.mjs'` 相对引用
- 插件是真实 Node 模块：可用 `node:fs`/`node:path`；config 里用 `!!js dshHomePath('子目录')` 取路径
- 服务要在插件对象上声明 `inject: ['systemPrompt','agentPresets',...]`，apply 里直接用 `ctx.systemPrompt`；工具用 `ctx.get('tools').register({...})` 注册，不用 import harness 包
- 校验：`node --check xxx.mjs` 验语法；`dsh --profile web --dump-config` 组合校验（会把空根回写 cordis.yml，无害）
- 动态插件（cordis_define/run）只是临时演示；web 的 HMR 关闭，改文件要重启

## 踩坑：不声明 inject，apply 时服务是 undefined

- 症状：插件「加载成功」但啥都没干、终端无报错；`ctx.get('systemPrompt')` 返回 undefined，被 `if` 静默跳过
- 原因：没声明 inject，loader 不等服务挂载完就激活插件
- 修法：插件对象加 `inject: ['systemPrompt','agentPresets']`，apply 里直接用 `ctx.xxx`
- 定位：把 apply 每步写到日志文件（如 `DOCUMENT/.mode-experience.log`），重启后读日志；终端看不到报错，是因为 apply 静默 no-op 而非真成功

## subagent 委派工具：host 侧有 ≠ 该模式能用（本次排查）

**核心结论**：host composition（`dsh-base` bundle）已经注册了 `subagents` 注册表 + `spawn`/`fork` 后端，甚至还有委派工具行；但**某个模式的 agent 工具清单只来自它自己 preset 的 scope，host scope 注册的工具不会自动出现**。所以「架构师模式调不起 subagent」的根因是该 preset 的 `agent.cordis.yml` 里没注册委派工具行，而不是 host 没开插件（用 `Service.listService` 能看到 `subagents` 服务是活的）。

**让某个模式能调 subagent，在该 preset 的 `agent.cordis.yml` 加这 4 行**（照抄 standard/code/cordis 的 `delegation` 组；无需 isolate realm）：

```yaml
- id: tool-subagent-control
  name: '@deepseek-ai/dsh-tool-subagent-control'

- id: tool-subagent-list-agents
  name: '@deepseek-ai/dsh-tool-subagent-control/list-agents'

- id: tool-subagent
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: spawn
    toolName: subagent
    backgroundMode: continuable

- id: tool-subagent-fork
  name: '@deepseek-ai/dsh-tool-subagent'
  config:
    provider: fork
    toolName: subagent_fork
    backgroundMode: continuable
```

对应工具：`subagent` / `subagent_fork` / `send_message`+`interrupt_agent`（control）/ `list_agents`。

**为什么不需要 isolate realm**：这 4 个包只 `inject`（消费 host 的 `tools`/`subagents`/`systemPrompt`/`agents`）并注册工具，**不 provide 任何 service**。只有 provide service 的行才必须 isolate（如 workflows 的 `workflowEngine`）。判断方法：grep 包源码里的 `inject` 和 `provide`。

## 路径索引：各类东西都在哪

**preset**
- 用户 preset：`~/.dsh/.agent-presets/<id>/`（`agent.cordis.yml` + `persona.md` + `preset.yml`）
- shipped preset（只读勿改）：`~/.npm/_npx/<hash>/node_modules/@deepseek-ai/dsh/config/agent-presets/{standard,code,minimal,cordis}/`
- `~/.dsh/DOCUMENT/{mode}.md` 是 symlink，真实文件在工作区 `document/`（可直接写，无需 escalation）

**host composition**
- profile 目录 `~/.dsh/profiles/web/`：`cordis.yml`（空根 `[]`，会被 `--dump-config` 回写，别手改）、`cordis.patch.yml`（用户 patch 层）
- 真正 host 行在 bundle：`~/.dsh/profiles/node_modules/@deepseek-ai/dsh-base/cordis.patch.yml`（`@deepseek-ai/dsh-subagent` 注册表 + `subagent-spawn-in-process`/`subagent-fork-in-process` 后端，约 292-341 行）

**工具包源码**（看 inject/provide 判断 realm 与依赖）
- `~/.dsh/profiles/node_modules/@deepseek-ai/<pkg>/lib/index.js`
- `dsh-tool-subagent` inject `['tools','subagents','systemPrompt']`
- `dsh-tool-subagent-control` inject `['tools','subagents']`；其 `list-agents.js` inject `['tools','subagents','agents']`

**运行时探查（cordis_inspect 只读）**
- 全部服务：`cordis_inspect_query` platform=host provider=`Service` method=`listService`（能看到 `subagents` 及 `start`/`startContinuable`/`followup`/`interrupt`/`listChildren` 等方法）
- 动态插件 host 可用 Builtin：`Builtin.listBuiltins`（只有 `ctx`/`harness`/`console`/`btoa`/`atob`/`TextEncoder`/`TextDecoder`，**无 `process`/`fs`**）
- 当前 agent 可见工具：`Tool.listTools`

## 踩坑：复制 cordis 出的 preset 会因 tool-cordis 全局 provider 冲突而回退（本次排查）

**症状**：「创造架构师」（cordis-architect，从 cordis 复制 + 加架构师人设）在 UI 选中后开始会话，会回退到 standard 或 cordis，而不是它自己。

**根因（不是 uuid）**：副本原样保留了 cordis 的 `tool-cordis`（`@deepseek-ai/dsh-tool-cordis`）行。该包 `apply()` 里会 `ctx.cordisInspect.register(provider)` 注册一组**进程级全局** inspect provider（`Service`/`Event`/`Builtin`/`Tool`），注册表是全局单例，每个 id 只能注册一次（源码 `dsh-tool-cordis/lib/index.js` 的 apply，`inject` 含 `cordisInspect`）。报错形如：

```
preset "cordis-architect" failed to mount: failed to apply loader entry tool-cordis:
Host Cordis inspect provider "Service" is already registered
```

**结论**：同一进程内，所有带 `tool-cordis` 的 preset（cordis / cordis-architect）互斥——先挂载的占住全局 provider，后挂的必失败。且挂载是 **standing mount，常驻到进程退出**，与会话关不关无关：重启后「第一个、且一直只开」其中一个才能用；一旦开过另一个就失效，得再重启。

**验证方法**：写临时插件 `inject: ['agentPresets']`，逐个调 `await ctx.agentPresets.standingKeyFor(id)` 做 mount-validate；成功返回 OK，失败抛错。当前进程里 `standingKeyFor('cordis')`=OK、`standingKeyFor('cordis-architect')`=FAIL 即复现。

**修复三选一**：
1. 重启 `dsh web` 后同进程只用 cordis 或 cordis-architect 其中一个（保留 tool-cordis，二者互斥）。
2. 从副本删掉 `tool-cordis` 行：保留「写 preset 文件 + editing-cordis-compositions skill + 人设 + 委派」，失去 cordis_define/run/inspect 动态插件，可与 cordis 共存。
3. 把 `tool-cordis` 挪到 host composition 全局层（一劳永逸，但改动最大）。
