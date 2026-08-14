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
