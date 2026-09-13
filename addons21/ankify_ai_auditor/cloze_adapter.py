"""Cloze / Cloze (overlapping) 适配工具。

Raycast/ankifyd 对 4-8 项有限列表输出 `#### [cloze] {question}` Markdown 块，例如：

    #### [cloze] 这组列表的问题
    - item1
    - item2

本模块负责：

1. 用正则搜索/解析该块；
2. 把列表项转换成 Anki 原生连续 cloze：
       {{c1::item1}}
       {{c2::item2}}
3. 识别 Cloze / Cloze (overlapping) note type，便于审计插件正确处理 Text / Overlapping 字段。
4. 提供可在 Anki Browser 中搜索已有 cloze 的正则建议。

该适配对应 michalrus/anki-simple-cloze-overlapper 这类基于原生 Cloze 的
“Cloze (overlapping)” note type：Text 字段放 `{{cN::...}}`，Overlapping 字段放
模板选项（默认 `1 0 true false false 1 0`）。
"""

import re

CLOZE_LIST_HEADER = "#### [cloze]"

# 匹配 Markdown 中的 cloze-list 块；group body 是不含标题的列表行。
CLOZE_LIST_BLOCK_REGEX = re.compile(
    r"(?ms)^[ \t]*#{1,6}[ \t]*\[cloze\](?:[ \t]+(?P<question>.+?))?[ \t]*\n"
    r"(?P<body>(?:^[ \t]*[-*+][ \t]+.+?[ \t]*$\n?)+)"
)

# 单个列表项；用于把 body 拆成 items。
CLOZE_LIST_ITEM_REGEX = re.compile(r"(?m)^[ \t]*[-*+][ \t]+(?P<item>.+?)[ \t]*$")

# 搜索“这是一个 cloze-list 标题”的正则（Obsidian/Anki Browser 的 re: 搜索都可用）。
CLOZE_LIST_SEARCH_REGEX = r"^#{1,6}\s*\[cloze\](?:\s+.+)?\s*$"

# Anki 原生 cloze 语法 `{{c1::...}}`。
ANKI_CLOZE_REGEX = re.compile(r"\{\{c(?P<num>\d+)::(?P<text>.*?)\}\}", re.S)

# Anki Browser 搜索已有 cloze note 的正则建议（在搜索框用 re: 前缀）。
ANKI_BROWSER_CLOZE_SEARCH_REGEX = r"re:\{\{c\d+::.*?\}\}"

# Simple Cloze Overlapper 模板的常用默认选项：
# 前置展示 1 个 cloze；后置展示 0 个；展示所有 cloze；答后不 reveal 全部；
# 不 reveal hint；每张卡考 1 个 cloze；答后显示后续 0 个。
DEFAULT_OVERLAPPING_OPTIONS = "1 0 true false false 1 0"

CLOZE_NOTE_TYPE_HINTS = ("cloze", "overlapping")


def is_cloze_markdown(text: str) -> bool:
    """文本中是否包含 cloze-list 块。"""
    return bool(CLOZE_LIST_BLOCK_REGEX.search(text or ""))


def parse_cloze_list_markdown(text: str):
    """解析第一个 cloze-list 块，返回列表项数组；找不到返回 []。"""
    match = CLOZE_LIST_BLOCK_REGEX.search(text or "")
    if not match:
        return []
    return [m.group("item").strip() for m in CLOZE_LIST_ITEM_REGEX.finditer(match.group("body")) if m.group("item").strip()]


def parse_cloze_list_block(text: str):
    """解析第一个 cloze-list 块，返回 {question, items}；找不到返回 None。"""
    match = CLOZE_LIST_BLOCK_REGEX.search(text or "")
    if not match:
        return None
    items = [
        m.group("item").strip()
        for m in CLOZE_LIST_ITEM_REGEX.finditer(match.group("body"))
        if m.group("item").strip()
    ]
    if not items:
        return None
    return {"question": (match.group("question") or "").strip(), "items": items}


def parse_all_cloze_list_markdown(text: str):
    """解析文本中所有 cloze-list 块，返回 `[(items, match), ...]`。"""
    results = []
    for match in CLOZE_LIST_BLOCK_REGEX.finditer(text or ""):
        items = [
            m.group("item").strip()
            for m in CLOZE_LIST_ITEM_REGEX.finditer(match.group("body"))
            if m.group("item").strip()
        ]
        if items:
            results.append((items, match))
    return results


def render_cloze_list_markdown(items, header: str = CLOZE_LIST_HEADER, question: str = "") -> str:
    """把列表项渲染成 Raycast 约定的 Markdown 块。"""
    cleaned = [str(item).strip() for item in items if str(item).strip()]
    if not cleaned:
        return ""
    title = header + (" " + question.strip() if question.strip() else "")
    return title + "\n" + "\n".join("- " + item for item in cleaned) + "\n"


def items_to_anki_cloze_text(items, start: int = 1) -> str:
    """把列表项转换成连续的原生 Anki cloze 文本。"""
    lines = []
    number = start
    for item in items:
        text = str(item).strip()
        if not text:
            continue
        # 避免内容里的 `}}` 提前截断 cloze；Anki 正文中同时出现两个右括号会解析失败。
        text = text.replace("}}", "} }")
        lines.append("{{c%d::%s}}" % (number, text))
        number += 1
    return "\n".join(lines)


def extract_anki_cloze_items(text: str):
    """从已有 Anki cloze 文本中按 c 编号提取内容。"""
    matches = list(ANKI_CLOZE_REGEX.finditer(text or ""))
    matches.sort(key=lambda m: (int(m.group("num")), m.start()))
    return [m.group("text").strip() for m in matches]


def make_cloze_note_fields(items, overlapping_options=None, extra: str = ""):
    """构造 Cloze (overlapping) note 字段。"""
    text = items_to_anki_cloze_text(items)
    if extra.strip():
        text = (text + "\n\n" + extra.strip()).strip()
    return {
        "Text": text,
        "Overlapping": (overlapping_options or DEFAULT_OVERLAPPING_OPTIONS).strip(),
    }


def is_cloze_note_type(model_name: str, fields=None) -> bool:
    """判断 note 是否属于 Cloze / Cloze (overlapping) 类型。"""
    model_lower = (model_name or "").lower()
    if any(hint in model_lower for hint in CLOZE_NOTE_TYPE_HINTS):
        # “Cloze” 单独出现即可；避免把普通名字里恰好含 overlapping 的误判为基本卡时，
        # 仍以字段特征做二次确认。
        return True
    if fields:
        text = fields.get("Text") if isinstance(fields, dict) else None
        if isinstance(text, str) and ANKI_CLOZE_REGEX.search(text):
            return True
    return False


def cloze_field_names(fields):
    """返回 cloze note 中应重点编辑的字段名。"""
    fields = fields or {}
    if "Text" in fields:
        return "Text", "Overlapping" if "Overlapping" in fields else None
    keys = list(fields.keys())
    return (keys[0], keys[1] if len(keys) > 1 else None)
