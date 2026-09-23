# DSH Token 优化：经验 skill 化 + persona 瘦身 + 历史控制 + 工具行精简

> 背景：昨天 DeepSeek 开放平台调用，输入约 7000 万 token，其中未命中 200 万（命中率 ≈ 97%）。
> 结论：缓存已到顶（97% > Reasonix 的 85%），**不做 Reasonix 式重构**；真正的杠杆是「减少每轮重发的固定前缀 + 控制历史滚雪球」。
> 本文件是 code/standard 会话的执行规格，决策已全部拍板，实施时不得自行改设计。

---

## 0. 目标与成功标准

- 把「每轮重发的固定前缀」从 ~46KB 压到 ~3KB（用户可控层）。
- 经验内容、persona 细则从「强制注入」变为「按需 skill」。
- 保留：GENERAL.md 常驻、cordis 双平面 core、基础 subagent 委派四件套、本 preset 全部核心工具。
- 禁用：`workflow`（工具 + 后端）、`ralph`（方法论降级为 `orchestration` skill）。
- 成功标准（验收）见 §6。

---

## 1. 总控表（单一事实来源）

| 组 | 条目 | 现在 | 目标 | 关联说明 |
|---|---|---|---|---|
| 注入层 | `{mode}.md` 自动注入 | 开 | **关** | 拆成 skill，按需加载 |
| 注入层 | `GENERAL.md` 自动注入 | 开 | 开 | 保留（568B 通用经验） |
| 注入层 | 经验 section → skill | 无 | **开(新增)** | 每节一个 skill，`{mode}-{slug}` |
| 注入层 | `mode-experience` 索引 skill | 开 | 开(瘦身) | 更新为列出新 skill |
| persona | cordis 双平面 core（L17–29） | 开 | 开 | 保留，原样 |
| persona | architect 内联人设（L31–157） | 开(14KB) | 压缩(≈2KB) | 只留骨架，见 §3.2 |
| persona | 工作流程 5 步细则 | 内联 | → skill | `architect-workflow`，见 §3.3 |
| persona | 外包管理协议 | 内联 | → skill | `architect-delegation`，见 §3.3 |
| persona | event config 专家（L152–157） | 内联 | **关** | 删除 |
| 历史 | tool-result-pruner 阈值 | 8192 | 4096 | 更早截断 |
| 历史 | grep/glob 排除 node_modules | 无 | 开(习惯) | 防 mermaid.js 式灌入 |
| 工具·shell | tool-bash | 开 | 开 | 保留 |
| 工具·shell | tool-pwsh | 关(mac) | 关 | 已 disabled |
| 工具·fs | tool-fs | 开 | 开 | 保留 |
| 工具·fs | tool-fs-search | 开 | 开 | 保留 |
| 工具·jobs | tool-jobs | 开 | 开 | 保留 |
| 工具·goal | tool-goal | 开 | 开 | 保留 |
| 工具·plan | plan-mode | 开 | 开 | 保留 |
| 工具·compaction | compaction-basic + command-compact | 开 | 开 | 保留 |
| 工具·compaction | tool-result-pruner | 开 | 开(调阈值) | 8192→4096 |
| 工具·委派 | tool-subagent (spawn) | 开 | 开 | 基础委派，**保留** |
| 工具·委派 | tool-subagent-fork | 开 | 开 | 基础委派，**保留** |
| 工具·委派 | tool-subagent-control | 开 | 开 | send/interrupt，**保留** |
| 工具·委派 | tool-subagent-list-agents | 开 | 开 | 基础委派，**保留** |
| 工具·委派 | tool-subagent-codex | 关 | 关 | 已 disabled |
| 工具·委派 | tool-subagent-claude-code | 关 | 关 | 已 disabled |
| 工具·委派 | tool-workflow | 开 | **关** | 方法论 → `orchestration` skill |
| 工具·委派 | workflow-worker-thread | 开 | **关** | workflow 后端，同开同关 |
| 工具·委派 | tool-ralph | 开 | **关** | 方法论 → `orchestration` skill |
| 工具·ask | tool-ask-user | 开 | 开 | 保留 |
| 工具·todo | tool-todo | 开 | 开 | 保留 |
| 工具·web | tool-web | 开 | 开 | 保留 |
| 工具·cordis | tool-cordis | 开 | 开 | 本模式核心 |
| 工具·skill | skill-filesystem | 开 | 开 | 保留 |
| 工具·skill | tool-skill | 开 | 开 | 保留 |
| 工具·skill | skill: `architect-workflow` | 无 | **开(新增)** | persona 细则 |
| 工具·skill | skill: `architect-delegation` | 无 | **开(新增)** | 外包协议 |
| 工具·skill | skill: `orchestration` | 无 | **开(新增)** | 替代 workflow/ralph |

**关联铁律：**
1. `tool-workflow` ↔ `workflow-worker-thread` 成对，一起关。
2. `tool-ralph` 独立；禁它不影响 `subagent`/`subagent_fork`（它们共用 `spawn` 后端，保留）。
3. 基础委派四件套（spawn/fork/control/list-agents）全保留，缺一断链。
4. **工具行改动 = 前缀字节变化 → 一次性成批改**（Part 4 一起做）。

---

## 2. Part 1 — `mode-experience` 插件重构

文件：`plugins/mode-experience.mjs`（host 面，profile `cordis.patch.yml` 引用，install.sh 用 symlink 部署）。

### 2.1 现状
- boot 时把 `~/.dsh/DOCUMENT/*.md`（顶层，不含 `feature_intent/` 子目录）读进内存。
- `systemPrompt.section`（order 500）自动注入 `GENERAL.md` + 当前 preset 同名的 `{mode}.md`。
- 另注册一个 `mode-experience` 索引 skill。

### 2.2 新行为规格
1. **只自动注入 `GENERAL.md`**：`systemPrompt.section` 的 `text` 返回 `generalContent`（不再拼 `{mode}.md`）。
2. **解析每个非 GENERAL 的 `document/*.md`**（`name === 'GENERAL'` 之外的顶层 `.md`），以 `####` 为分界注册成多个 skill。
3. 保留 `mode-experience` 索引 skill，内容改为列出所有注册出的 skill。

### 2.3 解析算法（精确规格）
- 对每个文件：`mode = 文件名去掉 .md`（如 `cordis`、`cordis-architect`）。
- 用正则按行匹配 section 标题：`/^####\s*(?:\[([a-z0-9-]+)\]\s*)?(.*)$/`。
  - `slug` = `[...]` 捕获（必须是 `[a-z0-9-]+`），缺省则回退 `${mode}-${index}`（index 从 1 起）。
  - `title` = 标题行剩余部分（trim）。
- 第一个 `####` 之前的内容 = preamble → **丢弃**。
- 每个标题 = 一节：`body` = 标题行之后到下一个标题行（不含）或 EOF，trim 首尾空行。
- skill 名 = `${mode}-${slug}`；sanitize 成小写 kebab，非法字符转 `-`；进程内重名时后缀 `-2`/`-3` 并 `log()` 警告。
- `description` = `title`；若 body 首行非空且较短，追加 ` — ${首行}`（截到 ~120 字符）。
- `content` = `# ${title}\n\n${body}`。
- 用 `ctx.skills.register({ name, description, source: 'runtime', content })` 注册（与现有 `mode-experience` skill 同一 API，已验证会出现在模型 available_skills）。

### 2.4 边界情况
- 文件无 `####` → 整个文件注册为 1 个 skill `${mode}-overview`（不静默丢失）。
- body 为空 → 仍注册，`content = # ${title}`。
- slug 重名 → 见 2.3 后缀规则 + log。
- `feature_intent/`（子目录）保持不读、不动（`readdirSync` 不递归，天然排除）。

### 2.5 `.md` 文件迁移（内容编辑，非插件）
把 `document/cordis.md` + `document/cordis-architect.md` 重写为 `#### [slug] 中文标题` 格式，并**去重合并**：
- `cordis.md` 作为共享 cordis 经验的唯一事实源。
- `cordis-architect.md` 只保留「architect 独有增量」；与 cordis 重复的段落删掉（skill 全局可见，已由 `cordis-*` skill 覆盖）。
- 每节给稳定 slug（如 `#### [preset-lookup] 模式/preset 相关能力查找备忘`）。
- `GENERAL.md` 不动（继续常驻注入）。

---

## 3. Part 2 — persona 瘦身

文件：`presets/cordis-architect/agent.cordis.yml`。

### 3.1 保留（原样，L17–29）
`persona` 行的 `text` 从开头到 `Load the editing-cordis-compositions skill...` 这段 cordis 双平面 core，一字不改。它是 cordis 身份，含 `{{model}}`/`{{cwd}}` 模板变量。

### 3.2 压缩块（替换 L31–157，全文如下，直接替换）
```yaml
      # 架构师/技术导师模式 (Architect)

      你负责高维度思考、系统设计与排期，**严禁写业务代码**——不输出 `// implementation` 级实现，只输出架构图与决策树。

      不可谈判的行为准则：
      - 决策先行 (Phase 1)：先列选项的优缺点 / 工时 / 反悔成本 / 是否被实践，结论必须含「条件 A 选 X，条件 B 选 Y」；用户明确「同意/开始写吧」才进入实施。
      - 20/80 原则：优先最简单的基础实现，炫技功能发配 backlog 末尾。
      - 奥卡姆剃刀：永远质疑复杂性，稳定性 >>>> 炫技。
      - 激进坦率：直白指出致命缺陷与死亡螺旋，但必须附一条务实逃生通道。
      - 情境绝对主义：脱离业务场景谈架构就是耍流氓。
      - 反向推演：先锚定基准约束（时间/资源/水平）再谈方案。
      - 约束即自由：适当约束消解选择瘫痪，赋予调用方/玩家真正自由。

      操作流程：信息收集 → 澄清问题 → 建待办 → 确认方案 → 新开会话切 code/standard 执行（本模式不写业务代码）。详细步骤见 skill `architect-workflow`。

      委派与编排：用 subagent 当包工头时加载 skill `architect-delegation`；要铺开多 agent 时加载 skill `orchestration`。
```

### 3.3 拆出的 skill（新增文件）
写入 `presets/cordis-architect/skills/<name>/SKILL.md`（复用现有 `skill-filesystem` 的 `customSkillDirs: skills/`）。

**`architect-workflow/SKILL.md`**（5 步工作流细则，内容自现 L39–99 提炼）：
```markdown
# 架构师工作流程（详细）

1. 信息收集：用 read/grep/glob 收集上下文，查看 DOCUMENT/feature_intent 模块文档；不假设项目结构，先看再想。
2. 澄清问题：用 ask_user_question 提问，给 2–4 个建议选项。
3. 建待办：用 todo_write，每项具体可执行、按序、单结果；不给工时预估；计划文件放 /plans。
4. 确认方案：与用户头脑风暴，复杂流程附 Mermaid（避免 [] 内使用引号与圆括号）。
5. 切换模式执行：用户确认后，让其完成核心数据流注释与 model 代码，再新开会话选 code/standard 实施；末尾追加任务——测试修改、更新文档、提交 commit、csv 变更同步云端。

信息覆盖原则：tres 由 csv 解析生成则改 csv 不改 tres。模块文档：一个模块一个文档，名字只能是 some_module，只写「当前应有的功能与设计意图」，不写计划、不写某次任务。
```

**`architect-delegation/SKILL.md`**（外包管理协议，内容自现 L89–98）：
```markdown
# 外包管理协议 (AI Offloading)

用 subagent 当包工头时严格执行：
1. 上下文灌输：message 里毫无保留传递父任务核心背景与架构契约。
2. 边界锁定：明确子任务只干什么，措辞严厉——「仅执行概述工作，不得偏离或修改其他模块」。
3. 强制汇报：子任务干完必须在最终回复给高度浓缩的结果摘要。
4. 任务解耦：跨技术栈/模块的脏活拆成多个连续或并行 subagent，别让单个子任务超载。

验收：子任务全部汇报后，由架构师综合碎片，给出最终架构概述。
```

### 3.4 删除
- 原 L152–157「event config 事件库设计专家」整段删除（已拍板：删，不转 skill）。
- 原 L39–147 的工作流程/执行管道细则，压缩进 §3.2 + 迁移进 §3.3 后删除原文。

### 3.5 范围说明
本次只处理 `cordis-architect` 的内联 persona。`presets/architect/persona.md`（7.9KB）与 `presets/g-chat/persona.md`（23KB）是**独立 preset**，其中 g-chat 的 23KB 人设是更大的 token 来源，如需一并瘦身另开任务。

---

## 4. Part 3 — 历史控制（接着做）

1. `agent.cordis.yml` 里 `tool-result-pruner` 的 `thresholdChars: 8192` → `4096`（保留 `headChars: 4096` / `tailChars: 1024` 不变）。
2. grep/glob 使用习惯：加 `include` 过滤、避开 `node_modules` 与 `*.min.js`/vendored 大文件（本次 grep `cache` 命中 78KB 压缩 mermaid.js 即为反例）。read 用 `offset`/`limit` 分段。
3. 长会话早触发 compaction（`compaction-basic` 已启用，无需改配置；靠使用习惯）。

---

## 5. Part 4 — 工具行精简（最后一起做）

在 `presets/cordis-architect/agent.cordis.yml` 的 `delegation` 组内：
- `tool-workflow` 加 `disabled: true`。
- `workflow-worker-thread` 加 `disabled: true`。
- `tool-ralph` 加 `disabled: true`。
- `subagent-codex` / `subagent-claude-code` 维持现状（已 disabled）。

并新增 `orchestration` skill（见 §3.3 目录）：
```markdown
# 多 agent 编排（替代 workflow / ralph 工具）

本模式已禁用 workflow / ralph 工具，编排改用基础 subagent 手工铺：

fan-out（原 workflow）：
- 拆成 N 个自包含子任务 → 并行 subagent / subagent_fork。
- 结果回传：要求每个子代理在最终回复给结构化摘要。
- 分阶段：手工按轮次收敛，不做 pipeline()/parallel() helper。

新鲜迭代（原 ralph）：
- 用不继承上下文的 subagent（或新开会话），共享工作区当持久记忆。
- 每轮只看上一轮的有界结构化报告，不污染父对话。
```

> 一次性成批改，接受一次前缀 miss，之后重新稳定。别零敲碎打。

---

## 6. 部署与验收

### 6.1 部署（DSH 修改契约：改本地文件 → install.sh 同步）
```bash
node --check plugins/mode-experience.mjs    # 验语法
./install.sh                                # 部署（插件 symlink / preset 拷贝 / doc symlink）
# 重启 dsh web（web HMR 关，preset 是真实拷贝，必须重启 + 重新选 preset）
```

### 6.2 验收标准
1. `node --check` 通过；`install.sh` 无报错。
2. 新会话 system prompt 里**不再有** 16KB 的 `cordis-architect.md` 全文；`GENERAL.md` 仍在。
3. available_skills 列表出现 `cordis-*`、`cordis-architect-*`、`architect-workflow`、`architect-delegation`、`orchestration`。
4. `skill('cordis-architect-preset-lookup')` 返回对应 section 内容。
5. `workflow`/`ralph` 从工具目录消失，`subagent`/`subagent_fork`/`send_message`/`list_agents` 仍在。
6. persona 显示为压缩骨架；`event config 专家` 不再出现。
7. `.mode-experience.log` 无 ERROR；会话正常启动不回退。
8. 命中率：预期一次性 miss 后恢复（工具行/prefifx 变更导致），长期命中率不劣化。

### 6.3 提交（Git 契约：只读之外的 git 操作由用户执行）
```bash
git add -A && git commit -m "refactor: 经验 skill 化 + persona 瘦身 + 历史控制 + 精简编排工具"
```
（本模式不执行 git 写操作，命令仅供用户自行运行。）
