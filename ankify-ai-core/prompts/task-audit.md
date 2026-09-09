# task-audit

任务：审计一批已有 Anki note，对每条 note 决定 keep / modify / split。

输入：一个 JSON 数组，每项是一条 note 的元数据：
- guid：外部唯一标识。
- model：note type 名称。
- fields：字段名到内容的映射。
- tags、decks、card_templates：上下文信息。
- review：该 note 各 card 的聚合复习数据（card_count、lapses、leech、avg_ease、max_interval 等）。

处理规则：
1. 语言规则：modify/split 生成的 fields 必须保持原 note 的原始语言，不得翻译。
2. 逐条评估 note 是否符合 policy 的卡片制作 criteria；重点看 fields 中实际作为 front/back 的字段内容，并结合 review 数据判断是否已经失败（lapses 高、leech=true、avg_ease 低）。
3. 决策：
   - 合适：不调用任何工具，表示 keep。
   - 不合适但只需修改：调用 modify_note。通常用于措辞冗长、有背景噪音、缺最小语境、yes/no 卡改造。
   - 不合适且需要拆解：调用 split_note。通常用于答案包含枚举/序列/层级/多问点。
4. 使用 note 的 guid，不要使用 id。
5. modify_note 的 fields 只包含需要修改的字段；键名必须与输入中的字段名完全一致；未提及的字段保持不变。
6. split_note 的 new_notes 中，每个新 note 的 fields 键名沿用原 note type 的字段名；新 note 内容必须符合最小信息原则。
7. reset_scheduling 仅在 front 检索键语义发生实质变化时设为 true。
8. 每条 reason 用一句话说明理由，便于用户在 dry-run 中理解。
9. 如果 note 语义不完整、无法判断，宁可不调用任何工具。

输出：通过 function calling 返回工具调用；keep 的 note 不产生工具调用。
