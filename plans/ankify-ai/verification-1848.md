# 1848 时间线 prompt 验证报告

## 结论

**PASS（静态验证）**。

当前环境未检测到可用的 LLM 端点或 API key（`OPENAI_API_KEY` 等未设置，`localhost:11434` 无 Ollama 服务），因此本次验证采用“手工 prompt 走查 + 金标准输出 + Schema 校验”。真实模型接入后，用同一批文件重放即可完成动态验证。

## 验证对象

- 审计场景：把 1848 二月革命反模式 note 交给 `task-audit` 流程，预期 AI 调用 `split_note`。
- 生成场景：`examples/ankify_examples.json` 中 1848 时间线文本，预期输出 9 张原子卡。
- 分类场景：`examples/classify_examples.json` 中 1848 时间线文本，预期分类为 `A4+B3+B8 / structural / two-pass`。

## 验证步骤

1. 组装 system prompt：
   `system-core.md + policy.md + task-audit.md`（共 5883 字符）。
2. 组装 user prompt：1848 反模式 note 的 JSON（503 字符）。
3. 用 `examples/audit_examples.json` 的金标准动作校验：
   - 动作必须是 `split_note`；
   - 新 note 数 6 条；
   - 每条新 note 的字段名与原 note type 一致；
   - `type_hint` 均在 A1-B8 枚举内；
   - 原始 52 字长答案不出现在任何新 note 中；
   - 每条新 note 的 Back 均小于 60 字符。
4. 校验所有 JSON 文件可解析；`card.json`、`classify_result.json`、`ankify_result.json`、`audit_tools.json` 的枚举字段与示例数据一致。

## 拆解结果（金标准）

原 note：`Front: 1848 二月革命从 2.22 到 2.25 发生了什么？ / Back: 2.22 示威，2.23 基佐辞职、卡普辛大道枪击，2.24 路易·菲利普退位，2.25 第二共和国成立`

拆为：
1. A4：2.22 发生了什么 → 反基佐政府的大规模示威
2. A4：2.23 发生了什么 → 卡普辛大道枪击（52 死 74 伤）
3. A4：2.24 国王做了什么 → 宣布退位
4. A4：2.25 凌晨宣布了什么 → 法兰西第二共和国成立
5. B3：邻接卡 2.22 示威 → 2.23 ____ → 2.24 ____
6. B8：整合卡 一句话串起 2.22–2.25

## 真实模型接入后的重放方法

1. 用 `system-core.md + policy.md + task-audit.md` 作为 system。
2. 把 1848 反模式 note JSON 作为 user。
3. 挂载 `schemas/audit_tools.json` 作为 tools。
4. 检查返回的 tool call 是否为 `split_note`，并校验其参数结构与上述金标准一致。

## 动态验证待办

- 至少用两个不同模型重放，比较 `split_note` 触发率和字段质量。
- 若单轮触发率低，按 `task-classify.md` 先分类，再走两轮模式复测。
