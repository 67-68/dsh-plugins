# 1848 时间线 live 验证报告（DeepSeek）

## 结论

**PASS（真实模型验证）**。

使用 `~/.zshrc` 中的 `DEEPSEEK_API_KEY`，模型为 `deepseek-chat`（服务端返回 `deepseek-v4-flash`），temperature=0。

## 验证 1：audit 场景（1848 反模式 note）

- system = `system-core.md + policy.md + task-audit.md`
- user = 1848 反模式 note JSON（guid `11111111-...`）
- tools = `schemas/audit_tools.json`
- 结果：`finish_reason=tool_calls`，1 个工具调用 `split_note`，9 条新 note。

拆出：
1. A4：2.22 爆发了什么
2. A4：2.23 发生了什么（基佐辞职；卡普辛枪击）
3. A4：2.24 国王做了什么
4. A4：2.25 凌晨宣布了什么
5. A4：枪击发生在哪天
6. A4：退位是哪天
7. A4：共和国哪天成立
8. B3：邻接卡
9. B8：整合卡

校验全部通过：字段名合法、type_hint 在 A1-B8、原长答案未保留、每条新 note 符合最小信息原则。

## 验证 2：ankify 场景（1848 时间线文本）

- system = `system-core.md + policy.md + task-ankify.md`
- user = 1848 时间线文本
- 使用 `response_format={"type":"json_object"}`
- 结果：9 张 cards，A4 节点卡 + 反向日期卡 + B3 邻接卡，全部通过 `card.json` 枚举校验。

## 备注

- 当前 core 版本 `0.1.0` 的 prompt 对 DeepSeek 有效，无需两轮模式即可正确 split。
- 建议后续换 1-2 个模型复测，观察 `split_note` 触发率和字段稳定性。
