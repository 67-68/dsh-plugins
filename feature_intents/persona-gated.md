# 锚定模式 persona 门控 (persona-gated)

让 anchored-architect 的首轮 system prompt 保持 Minimal 基线不变，晋升后把该模式的架构师经验（`GENERAL.md` + `anchored-architect.md`）注入为 **system prompt 本体**，而不是 user message。

## 为什么需要

- `dsh-persona` 的 `complete: true` 会在 assembly 后把 system prompt 收敛成唯一 section，其他 `systemPrompt.section` 全部被丢弃。
- `mode-experience` 原用 section 注入，对 complete persona 完全失效。
- 改用 pre-step user message 注入后，模型把它当普通用户文本，不会当作核心人格执行。
- system prompt 里唯一能幸存的通道就是 complete section 自身。因此本模块直接注册 `deployment:persona`，让经验文本成为 system prompt 的一部分。

## 功能

- 注册 `deployment:persona`（order `0`，`complete: true`），替代 `@deepseek-ai/dsh-persona` 在该 preset 中的静态 persona。
- 未晋升：返回与 Minimal preset 字节一致的 `basePersona`。
- 晋升后：在第 1 个晋升 turn 返回 `basePersona + GENERAL.md + {mode}.md`，之后每隔 `modeExperienceInterval` 个晋升 turn 再注入一次（默认 `2`，即第 2、4、6…轮）；非注入轮保持 Minimal 基线。
- 晋升判定复用 `compaction-epoch.mjs`：`tool/call` 或 `assistant/message` 晋升，`compaction/end` 降级，首轮/压缩后首轮保持 Minimal。
- `includeSubagents: true` 时，子代理同样先过 Minimal 首轮再晋升。

## 数据源与边界

- 数据源：`~/.dsh/DOCUMENT/GENERAL.md` 与 `~/.dsh/DOCUMENT/{mode}.md`，在插件 mount 时读入内存缓存。
- 仅服务 `anchored-architect`；其他模式的 `GENERAL.md` 注入与 `{mode}.md` skill 解析仍由 `mode-experience` 负责，保持原状。
- `mode-experience` 对 `promoteGatedModes` 只跳过 `GENERAL.md` section，避免重复注入。
- 本模块是 preset-local 插件，随 `presets/anchored-architect/` 被 `install.sh` 以真实目录拷贝到 `~/.dsh/.agent-presets/`。
- 不负责 skill 解析、skill 索引或非 gated 模式的任何注入。
