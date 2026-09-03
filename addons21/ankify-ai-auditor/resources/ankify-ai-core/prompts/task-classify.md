# task-classify

任务：阅读用户提供的文本，判断其中包含哪些卡片类型，并给出建议的生成流水线。

输入：一段 OCR/多模态识别后的文本（可能包含标题、正文、列表）。

处理步骤：
1. 根据 policy 第 2 节的分类表，识别文本中出现的所有卡片类型。
2. 判断文本整体属于 atomic、structural 还是 mixed。
3. 给出 pipeline 建议：
   - 默认 single-pass。
   - 当文本包含复杂时间线、层级树、长列表、多个概念网络，或预计一次生成错误率较高时，建议 two-pass。
4. 用一句话 source_summary 概括材料主题。
5. 可以在 notes 中给文本的关键段落做简短标注（例如“这段是 B3 时间线，需要拆成节点卡和邻接卡”）。

输出：严格符合 classify_result.json 的 JSON 对象。
