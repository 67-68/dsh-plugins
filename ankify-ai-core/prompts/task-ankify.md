# task-ankify

任务：把用户提供的文本/图片识别结果转成一套最小信息卡片。

输入：
- 文本内容，或图片识别结果。
- `mode`：当前制卡模式，见下方。
- 可选：`classify_result.json` 格式的分类结果（two-pass 模式）。
- 可选：背景/上下文。不同模式下含义不同。

模式：
1. `image`：图片模式。先识别图片文字，再制卡；背景是字面意义的来源/范围。
2. `bulk-text`：批量文本模式。输入通常是大段文本，用户可用 `**...**` 或 `==...==` 标记出需要制卡的核心片段；背景也可给出这种格式示例（例如 `**abc**dd` 表示只把 abc 作为核心目标）。
3. `simple-cards`：批量简单卡片模式。输入的每一行是一条卡片的 front；用户不提供 back，背景用于说明需要的 back 类型（词汇释义、题目答案、定义、日期等）。

处理步骤：
1. 先理解输入，再拆解；不理解的内容不要制卡。
1a. 语言规则：所有 front/back/items 保持用户输入文本的原始语言；不得翻译成其他语言。
2. 按 policy 的 criteria 制作卡片：
   - 原子事实直接做 front-back 卡片。
   - 时间线按“节点卡 + 邻接卡 + 少量整合卡”拆分。
   - 层级按“父→子、子→父、兄弟区分、属性”拆分。
   - 列表按封闭/开放列表分别处理，禁止“列出全部成员”卡。
   - 概念按属性/相似差异/部分整体/因果/意义等透镜拆分。
3. 有限列表识别（强制规则）：只要一张普通卡片的答案是 4-8 个并列项（例如用逗号、分号、顿号、换行、`- item` 分隔），就必须输出一个 `format="cloze-list"` 的特殊 card，而不是普通 front/back card。该 card 写：
   - `format`: `"cloze-list"`
   - `front`: 原问题；如果没有问题，就用整个列表的主题作为 front
   - `cloze_items`: 按顺序排列的列表项数组（已拆好，不要保留分隔符）
   - `type`: `"B1"`（或更合适的 B 类）
   - `extra`: 可选来源/说明
   Raycast/Anki 端会把它渲染为：
   ```
   #### [cloze] {front}
   - item1
   - item2
   ```
   并转换成 Anki Cloze Overlapping 可用的连续 cloze。

   反例：
   ```json
   { "front": "What was the motivation of the Declaration of Heidelberg?", "back": "common defense, external representation, national representation, removal of inter and outer danger", "type": "B1" }
   ```
   正确输出：
   ```json
   { "format": "cloze-list", "front": "What was the motivation of the Declaration of Heidelberg?", "cloze_items": ["common defense", "external representation", "national representation", "removal of inter and outer danger"], "type": "B1", "extra": "" }
   ```

   列表项数控制在 4-8 个；超过 8 个时拆成多个主题明确的 cloze-list 或改用其他策略。
4. 只输出材料中能支持的内容；不编造。
5. 同一事实可以有多张卡（如正反向卡、邻接卡），但每张卡必须符合最小信息原则。

输出：严格符合 ankify_result.json 的 JSON 对象。不要输出 Markdown；Markdown 由调用方渲染。

输出骨架（pipeline 必须使用这两个字面量之一）：
```json
{
  "cards": [
    { "front": "问题", "back": "最短答案", "type": "A1", "tags": [], "extra": "" }
  ],
  "pipeline": "single-pass",
  "source_summary": "一句话说明材料主题"
}
```

有限列表 card 示例：
```json
{
  "cards": [
    { "format": "cloze-list", "front": "这组列表的共同问题", "cloze_items": ["item1", "item2", "item3"], "type": "B1", "extra": "" }
  ],
  "pipeline": "single-pass"
}
```
