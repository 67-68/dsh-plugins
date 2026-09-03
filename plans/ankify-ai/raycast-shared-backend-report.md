# 给 Raycast 插件团队的共享后端对接说明

> 用途：让 Raycast「图片 → Markdown 卡片」插件复用 Ankify AI 的共享 core，避免另写一套提示词和分类法。
> 读者：实现 Raycast 插件的 agent。

## 1. 一句话结论

Raycast 插件与 Anki 插件共享的是 **`ankify-ai-core` 数据资产**（policy + prompts + JSON Schema + examples），不是运行时代码。你只需要在你的扩展里 vendor 这个目录，写薄薄的加载和调用层。

## 2. 共享 core 目录

```text
ankify-ai-core/
  VERSION
  policy.md                  # 卡片分类法 A1-B8 + 制作 criteria + 1848 例子
  prompts/
    system-core.md           # 系统提示词主体（必须使用）
    task-classify.md         # 分类任务提示（两轮模式第一轮）
    task-ankify.md           # 文本 -> 卡片任务提示（Raycast 专用）
    task-audit.md            # note 审计任务提示（Anki 专用，你不用）
  schemas/
    card.json                # 卡片对象 Schema
    classify_result.json     # 分类输出 Schema
    ankify_result.json       # 文本转卡片输出 Schema
  examples/
    classify_examples.json
    ankify_examples.json
```

## 3. 使用方式

1. 构建/安装 Raycast 扩展时，把 `ankify-ai-core/` 复制进扩展资源目录。
2. 启动时读取 `VERSION`，确认与你 manifest 里声明的兼容版本一致。
3. 组装请求：
   - system = `system-core.md` + `task-ankify.md`
   - user = 图片 OCR/多模态识别后的文本（或图片本身，取决于模型）
   - 输出要求 = 按 `schemas/ankify_result.json` 返回 JSON
4. 调用 OpenAI 兼容 `chat/completions`，建议用 JSON mode 或结构化输出；不支持时用 function calling 兜底。
5. 把返回的 `cards` 数组渲染成 Markdown。

## 4. 输出契约

### 4.1 卡片对象

```json
{
  "front": "一句话问题或填空",
  "back": "最短答案",
  "type": "A1|A2|A3|A4|B1|B2|B3|B4|B5|B6|B7|B8",
  "tags": ["history"],
  "extra": "背景/助记/来源，不作考点"
}
```

### 4.2 ankify 结果

```json
{
  "cards": [ { "front": "...", "back": "...", "type": "A4", "tags": [] } ],
  "source_summary": "一句话说明材料主题",
  "pipeline": "single-pass"
}
```

## 5. Markdown 渲染约定（Obsidian-to-Anki）

Raycast 只负责把 `cards` 渲染成 Markdown。建议格式（最终与 Obsidian-to-Anki 插件约定对齐）：

```md
# 材料标题

Q: 1848 年 2 月 24 日，国王路易·菲利普做了什么？
A: 宣布退位

Q: 1848 年 2 月 25 日凌晨，拉马丁在市政厅宣布了什么？
A: 法兰西第二共和国成立
```

规则：
- 每个 card 一段，`Q: ` 和 `A: ` 成对出现。
- 需要双向卡时渲染为两个 block（front/back 互换）。
- 连续 cloze 用 Obsidian-to-Anki 约定语法（如 `{{c1::...}}` 或插件特定标记），不要在 core 层发明新语法。
- `extra` 渲染为答案后的括号内容，不作为考点。

## 6. 两轮模式（错误率高时启用）

1. 第一轮：system = `system-core.md` + `task-classify.md`；输出 `classify_result.json`。
2. 第二轮：system = `system-core.md` + `task-ankify.md` + 类型专门指令；user 带上第一轮标注后的文本；输出 `ankify_result.json`。
3. 触发条件由你在设置里暴露开关，默认单轮。

## 7. 不要做

- 不要修改 vendor 进来的 core 文件；如有通用问题，改 `ankify-ai-core` 源并升版本。
- 不要把你的 OCR/多模态细节写进 core prompt。
- 不要在 Markdown 里发明新的卡片语法，交给 Obsidian-to-Anki 既有约定。
- 不要把 `task-audit.md` 或 Anki 的 tool-call 逻辑引入 Raycast。

## 8. 验收标准

- 同一段 1848 时间线文本，Raycast 输出与 core 示例的卡片类型和拆分方式一致。
- 更换模型后，输出仍能通过 `schemas/ankify_result.json` 校验。
- Markdown 可直接被 Obsidian-to-Anki 插件识别导入。
