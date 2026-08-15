# cordis-architect 模式经验（继承自 cordis 模式）

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

## 踩坑：本模式（从 cordis 复制而来）会因 tool-cordis 全局 provider 冲突而回退（本次排查）

**症状**：本模式（cordis-architect）在 UI 选中后开始会话，会回退到 standard 或 cordis，而不是它自己。

**根因（不是 uuid）**：本 preset 原样保留了 cordis 的 `tool-cordis`（`@deepseek-ai/dsh-tool-cordis`）行。该包 `apply()` 里会 `ctx.cordisInspect.register(provider)` 注册一组**进程级全局** inspect provider（`Service`/`Event`/`Builtin`/`Tool`），注册表是全局单例，每个 id 只能注册一次（源码 `dsh-tool-cordis/lib/index.js` 的 apply，`inject` 含 `cordisInspect`）。报错形如：

```
preset "cordis-architect" failed to mount: failed to apply loader entry tool-cordis:
Host Cordis inspect provider "Service" is already registered
```

**结论**：同一进程内，所有带 `tool-cordis` 的 preset（cordis / cordis-architect）互斥——先挂载的占住全局 provider，后挂的必失败。且挂载是 **standing mount，常驻到进程退出**，与会话关不关无关：重启后「第一个、且一直只开」本模式才能用；一旦先开过 cordis，本模式就失效，得再重启。

**验证方法**：写临时插件 `inject: ['agentPresets']`，逐个调 `await ctx.agentPresets.standingKeyFor(id)` 做 mount-validate；成功返回 OK，失败抛错。当前进程里 `standingKeyFor('cordis')`=OK、`standingKeyFor('cordis-architect')`=FAIL 即复现。

**修复三选一**：
1. 重启 `dsh web` 后同进程只用 cordis 或 cordis-architect 其中一个（保留 tool-cordis，二者互斥）。
2. 从本 preset 删掉 `tool-cordis` 行：保留「写 preset 文件 + editing-cordis-compositions skill + 人设 + 委派」，失去 cordis_define/run/inspect 动态插件，可与 cordis 共存。
3. 把 `tool-cordis` 挪到 host composition 全局层（一劳永逸，但改动最大）。

## 双面包插件（permode-inventory）上线的四个坑（本次全程排查）

一个本地双面包插件（node 面 + browser 面）从写好到 `dsh web` 正常跑起来，踩了四个连环坑，按报错出现的顺序记：

### 坑 1：目录名 ≠ 包名 → `Cannot find package 'dsh-permode-inventory'`

- **症状**：`dsh web` 启动报 `Cannot find package 'dsh-permode-inventory' imported from ~/.dsh/profiles/web/`。
- **根因**：`packages/` 下目录名是 `permode-inventory`，但 `package.json` 的 `name` 是 `dsh-permode-inventory`；install.sh 第 5 步用 `basename` 当部署名，symlink 建成了 `node_modules/permode-inventory`，而 `cordis.patch.yml` 引用的是 `dsh-permode-inventory`，Node 永远解析不到。
- **修法**：目录名重命名为包名。仓库约定就是「basename = 包名」，改目录不是改脚本。

### 坑 2：`dsh` 命令不在 PATH → install.sh 提前退出

- **症状**：`./install.sh: line 86: dsh: command not found`，且 `set -euo pipefail` 让脚本中断。
- **根因**：平时用 `npx @deepseek-ai/dsh`，`dsh` 不在 PATH。
- **修法**：install.sh 里 `dsh plugin add` 改成 `npx --yes @deepseek-ai/dsh plugin add`，与日常启动命令同源。

### 坑 3：symlink 部署的包，Node realpath 后 peer 依赖解析失败

- **症状**：包名修对后，报错变成 `Cannot find package '@deepseek-ai/dsh-typert-protocol' imported from <仓库目录>/packages/dsh-permode-inventory/lib/index.js`。
- **根因**：dsh 运行时加载插件用的是默认 realpath（grep 过 dsh/cordis-plugin-loader 源码，**无 `--preserve-symlinks`**）。包是 symlink，Node 把模块真实路径解析回仓库目录，包内 `import "@deepseek-ai/dsh-typert-protocol"` 从仓库向上找 `node_modules`（仓库没有，已 gitignore），失败。而 `~/.dsh/profiles/node_modules/@deepseek-ai/` 下 peer 依赖全都在，只是 realpath 后找不到。
- **为什么 mode-experience.mjs 用 symlink 一直没事**：它只 import `node:fs`/`node:path` 内置模块，从不 import 裸包名。这是第一个 import 裸 peer 依赖的 symlink 包，才掉坑。
- **修法**：install.sh 第 5 步从 symlink 改成 `rm -rf + cp -R` 真实拷贝（与 presets 一致）。**双面包包必须真实拷贝，不能 symlink**，和 presets 是同一个物理边界。

### 坑 4：客户端 `remote.<namespace>` 服务必须自己 mount，不能只 inject

- **症状**：包修好能 boot 后，浏览器控制台报 `1 entry did not activate dsh-permode-inventory: pending (waiting for service: remote.permodeInventory)`。
- **根因链（找了很久）**：
  - host 侧 `TypertRemoteService` + `@Remote("list")` 是够的：`dsh-api-gateway` node 面有 **SRC 回退**（`resolveSrcDescriptor`），只要服务注册了 `typertRemote` 绑定 + Remote marker，host 就能反射出 descriptor 并 dispatch，**不需要生成 `./typert` 面文件**。
  - 但浏览器端 `remote.<namespace>` 服务由 `dsh-api-remotes` 的 client.js 在启动时 `$mount` 静态编译进去的 5 个 TYPERT_REMOTE contribution 提供（commands/goal/host-runner/message-feedback/plugin-inventory）。手写插件没有对应的 remote-client 面被编译进去，所以 `remote.permodeInventory` 服务永远不存在，`inject: ["remote.permodeInventory"]` 永远 pending。
- **修法**：client.js 不要 inject `remote.permodeInventory`，改成 `inject: ["remote"]`，在 `apply` 里自己 `await ctx.remote.$mount(手写的 TYPERT_REMOTE contribution)`。客户端要求 strict codec（`requireStrictDescriptor`），只需 `schema` 提供 `parse()` 方法即可，host 侧自己的 `assertJsonValue` 已保证 JSON-safe 输出。
- **关键源码位置**：
  - `dsh-api-gateway/lib/index.js` node 面 `resolveSrcDescriptor()`（SRC 回退，host 无需 typert 面文件）
  - `dsh-api-gateway/lib/client.js` `ClientRemoteService.$mount()` / `remoteServiceKey()`（`remote.` 前缀 → Cordis 服务名映射）
  - `dsh-api-remotes/lib/client.js` `apply()`（静态 5 个 contribution 的 `$mount`）
  - `cordis/lib/index.js` `_execute()`（async apply + thenable 返回值合法，返回 disposer 会被 collect）

### 坑 5：`$mount` 后访问服务要用 `ctx.get()`，点号访问会被 Guard 拦（坑 4 的补完）

- **症状**：坑 4 修完、entry 不再 pending 后，modes tab 仍报「无法读取」，console 显示 `cannot get property "remote.permodeInventory" without inject`（list() 里 `ctx.remote.permodeInventory.list()` 触发）。
- **根因**：Cordis 的 ctx 是 Proxy（`cordis/lib/index.js` 的 `ReflectService.handler.get`），`ctx.remote.permodeInventory` 这种**点号链**会被解析成服务名 `remote.permodeInventory` 并要求 `inject` 声明；而手写插件一旦 inject 它就死锁（inject 等 apply，apply 等 `$mount`）。官方 plugin-inventory 能点号访问，是因为 api-remotes 启动时就 `$mount` 了静态 contribution、inject 能解析；手写插件没这个前提。
- **修法**：`$mount` 之后**不要点号访问**，用 `ctx.get("remote.<namespace>")` 取服务（`ctx.get` 不要求 inject，绕开死锁），取到后直接 `service.list()`。记得处理 `undefined`（服务没挂上时）。
- **教训**：坑 4 只解决了「pending 死锁」，没解决「$mount 后怎么访问」——两者是同一个根因（inject 死锁）的两半，合起来才是完整修法：inject 只声明 `remote` → `$mount` 手动挂载 → `ctx.get("remote.<ns>")` 取服务。**自建 dual-face 包 + Typert Remote，这三步缺一不可。**

### 顺带：端口占用

- `dsh web` 验证时后台起的进程会占住 3080 端口，下次再 `npx @deepseek-ai/dsh web` 会 `EADDRINUSE`。查：`lsof -nP -iTCP:3080 -sTCP:LISTEN`，杀对应 PID 即可。
