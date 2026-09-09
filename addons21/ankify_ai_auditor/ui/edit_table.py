"""可编辑的审计结果表格模型。"""

from aqt.qt import (
    QAbstractTableModel,
    QBrush,
    QColor,
    QModelIndex,
    Qt,
)

HEADERS = ["动作", "原 Front", "原 Back", "新 Front", "新 Back", "类型", "标签", "理由"]
EDITABLE_COLUMNS = {3, 4, 5, 6}
TRIM_LIMIT = 40

COLOR_APPLIED = QColor("#1e3a5f")
COLOR_DISCARDED = QColor("#c99700")
COLOR_MIXED = QColor("#2e7d32")


def _enum(container_name, member_name, fallback):
    container = getattr(Qt, container_name, None)
    if container is not None:
        member = getattr(container, member_name, None)
        if member is not None:
            return member
    return fallback


ROLE_DISPLAY = _enum("ItemDataRole", "DisplayRole", getattr(Qt, "DisplayRole", 0))
ROLE_EDIT = _enum("ItemDataRole", "EditRole", getattr(Qt, "EditRole", 2))
ROLE_TOOLTIP = _enum("ItemDataRole", "ToolTipRole", getattr(Qt, "ToolTipRole", 3))
ROLE_BACKGROUND = _enum("ItemDataRole", "BackgroundRole", getattr(Qt, "BackgroundRole", 8))
HORIZONTAL = _enum("Orientation", "Horizontal", getattr(Qt, "Horizontal", 1))
FLAG_ENABLED = _enum("ItemFlag", "ItemIsEnabled", getattr(Qt, "ItemIsEnabled", 32))
FLAG_SELECTABLE = _enum("ItemFlag", "ItemIsSelectable", getattr(Qt, "ItemIsSelectable", 1))
FLAG_EDITABLE = _enum("ItemFlag", "ItemIsEditable", getattr(Qt, "ItemIsEditable", 2))


def _trim(text):
    text = str(text or "")
    if len(text) <= TRIM_LIMIT:
        return text
    return text[:TRIM_LIMIT] + "…"


class Row:
    __slots__ = (
        "action_index",
        "split_index",
        "kind",
        "front_field",
        "back_field",
        "orig_front",
        "orig_back",
        "front",
        "back",
        "type_hint",
        "tags",
        "reason",
        "status",
    )

    def __init__(self, **kwargs):
        for slot in self.__slots__:
            setattr(self, slot, kwargs.get(slot))


class AuditTableModel(QAbstractTableModel):
    def __init__(self, task_manager, tid, parent=None):
        super().__init__(parent)
        self.task_manager = task_manager
        self.tid = tid
        self.view_mode = "card"  # card | note
        self.rows = []
        self.refresh()

    # -- 视图切换 --
    def set_view_mode(self, mode):
        mode = "note" if mode == "note" else "card"
        if self.view_mode != mode:
            self.view_mode = mode
            self.refresh()

    # -- 状态计算 --
    def _action_status(self, action):
        if action["action"] == "modify":
            if action.get("discarded"):
                return "discarded"
            if action.get("applied"):
                return "applied"
            return "pending"
        items = action.get("new_notes") or []
        statuses = {self._item_status(item) for item in items}
        if len(statuses) == 1:
            return next(iter(statuses))
        if any(s != "pending" for s in statuses):
            return "mixed"
        return "pending"

    def _item_status(self, item):
        if item.get("discarded"):
            return "discarded"
        if item.get("applied"):
            return "applied"
        return "pending"

    def _status_color(self, status):
        if status == "applied":
            return COLOR_APPLIED
        if status == "discarded":
            return COLOR_DISCARDED
        if status == "mixed":
            return COLOR_MIXED
        return None

    def _is_editable_row(self, row):
        return row.status == "pending" and row.front_field is not None

    # -- 数据构建 --
    def refresh(self):
        self.beginResetModel()
        self.rows = []
        task = self.task_manager.get_task(self.tid)
        if task is None:
            self.endResetModel()
            return

        actions = task.get("actions") or []
        for action_index, action in enumerate(actions):
            original_fields = (action.get("original") or {}).get("fields") or {}
            keys = list(original_fields.keys())
            front_field = keys[0] if len(keys) > 0 else None
            back_field = keys[1] if len(keys) > 1 else None
            orig_front = original_fields.get(front_field, "") if front_field else ""
            orig_back = original_fields.get(back_field, "") if back_field else ""
            reason = action.get("reason") or ""

            if self.view_mode == "note":
                if action["action"] == "modify":
                    fields = action.get("fields") or {}
                    status = self._action_status(action)
                    self.rows.append(
                        Row(
                            action_index=action_index,
                            split_index=None,
                            kind="修改",
                            front_field=front_field,
                            back_field=back_field,
                            orig_front=orig_front,
                            orig_back=orig_back,
                            front=fields.get(front_field, orig_front) if front_field else "",
                            back=fields.get(back_field, orig_back) if back_field else "",
                            type_hint=action.get("type_hint") or "",
                            tags=", ".join(action.get("tags") or []),
                            reason=reason,
                            status=status,
                        )
                    )
                elif action["action"] == "split":
                    new_notes = action.get("new_notes") or []
                    status = self._action_status(action)
                    self.rows.append(
                        Row(
                            action_index=action_index,
                            split_index=None,
                            kind="拆分 %s 条" % len(new_notes),
                            front_field=front_field,
                            back_field=back_field,
                            orig_front=orig_front,
                            orig_back=orig_back,
                            front="",
                            back="",
                            type_hint="",
                            tags="",
                            reason=reason,
                            status=status,
                        )
                    )
            else:
                if action["action"] == "modify":
                    fields = action.get("fields") or {}
                    status = self._action_status(action)
                    self.rows.append(
                        Row(
                            action_index=action_index,
                            split_index=None,
                            kind="修改",
                            front_field=front_field,
                            back_field=back_field,
                            orig_front=orig_front,
                            orig_back=orig_back,
                            front=fields.get(front_field, orig_front) if front_field else "",
                            back=fields.get(back_field, orig_back) if back_field else "",
                            type_hint=action.get("type_hint") or "",
                            tags=", ".join(action.get("tags") or []),
                            reason=reason,
                            status=status,
                        )
                    )
                elif action["action"] == "split":
                    new_notes = action.get("new_notes") or []
                    for split_index, item in enumerate(new_notes):
                        fields = item.get("fields") or {}
                        status = self._item_status(item)
                        self.rows.append(
                            Row(
                                action_index=action_index,
                                split_index=split_index,
                                kind="拆分 %s/%s" % (split_index + 1, len(new_notes)),
                                front_field=front_field,
                                back_field=back_field,
                                orig_front=orig_front,
                                orig_back=orig_back,
                                front=fields.get(front_field, "") if front_field else "",
                                back=fields.get(back_field, "") if back_field else "",
                                type_hint=item.get("type_hint") or "",
                                tags=", ".join(item.get("tags") or []),
                                reason=reason,
                                status=status,
                            )
                        )
        self.endResetModel()

    # -- Qt model 接口 --
    def rowCount(self, parent=QModelIndex()):
        if parent.isValid():
            return 0
        return len(self.rows)

    def columnCount(self, parent=QModelIndex()):
        if parent.isValid():
            return 0
        return len(HEADERS)

    def _cell_text(self, row, col):
        if col == 0:
            return row.kind
        if col == 1:
            return row.orig_front
        if col == 2:
            return row.orig_back
        if col == 3:
            return row.front
        if col == 4:
            return row.back
        if col == 5:
            return row.type_hint
        if col == 6:
            return row.tags
        if col == 7:
            return row.reason
        return ""

    def data(self, index, role=ROLE_DISPLAY):
        if not index.isValid() or not (0 <= index.row() < len(self.rows)):
            return None
        row = self.rows[index.row()]
        col = index.column()
        if role == ROLE_DISPLAY:
            if col in (0, 5, 6):
                return self._cell_text(row, col)
            return _trim(self._cell_text(row, col))
        if role == ROLE_EDIT:
            return self._cell_text(row, col)
        if role == ROLE_TOOLTIP:
            return self._cell_text(row, col)
        if role == ROLE_BACKGROUND:
            color = self._status_color(row.status)
            if color is not None:
                return QBrush(color)
            return None
        return None

    def setData(self, index, value, role=ROLE_EDIT):
        if role != ROLE_EDIT or not index.isValid():
            return False
        if not (0 <= index.row() < len(self.rows)):
            return False
        row = self.rows[index.row()]
        col = index.column()
        if not self._is_editable_row(row) or col not in EDITABLE_COLUMNS:
            return False

        if col == 3:
            row.front = str(value)
            self._write_field(row, row.front_field, row.front)
        elif col == 4:
            row.back = str(value)
            self._write_field(row, row.back_field, row.back)
        elif col == 5:
            row.type_hint = str(value).strip()
            self._write_type(row, row.type_hint)
        elif col == 6:
            row.tags = str(value).strip()
            self._write_tags(row, row.tags)
        self.dataChanged.emit(index, index)
        return True

    def flags(self, index):
        if not index.isValid():
            return FLAG_ENABLED
        base = FLAG_ENABLED | FLAG_SELECTABLE
        row = self.rows[index.row()]
        if index.column() in EDITABLE_COLUMNS and self._is_editable_row(row):
            return base | FLAG_EDITABLE
        return base

    def headerData(self, section, orientation, role=ROLE_DISPLAY):
        if role != ROLE_DISPLAY:
            return None
        if orientation == HORIZONTAL and 0 <= section < len(HEADERS):
            return HEADERS[section]
        return None

    # -- 把编辑结果写回 action --
    def _task(self):
        return self.task_manager.get_task(self.tid)

    def _action(self, row):
        task = self._task()
        if task is None:
            return None
        actions = task.get("actions") or []
        if 0 <= row.action_index < len(actions):
            return actions[row.action_index]
        return None

    def _write_field(self, row, field_name, value):
        action = self._action(row)
        if action is None or field_name is None:
            return
        if action["action"] == "modify":
            action.setdefault("fields", {})
            action["fields"][field_name] = value
        elif action["action"] == "split" and row.split_index is not None:
            new_notes = action.get("new_notes") or []
            if 0 <= row.split_index < len(new_notes):
                new_notes[row.split_index].setdefault("fields", {})
                new_notes[row.split_index]["fields"][field_name] = value

    def _write_type(self, row, value):
        action = self._action(row)
        if action is None:
            return
        if action["action"] == "modify":
            action["type_hint"] = value
        elif action["action"] == "split" and row.split_index is not None:
            new_notes = action.get("new_notes") or []
            if 0 <= row.split_index < len(new_notes):
                new_notes[row.split_index]["type_hint"] = value

    def _write_tags(self, row, value):
        action = self._action(row)
        if action is None:
            return
        tags = [t.strip() for t in str(value).split(",") if t.strip()]
        if action["action"] == "modify":
            action["tags"] = tags
        elif action["action"] == "split" and row.split_index is not None:
            new_notes = action.get("new_notes") or []
            if 0 <= row.split_index < len(new_notes):
                new_notes[row.split_index]["tags"] = tags

    # -- 选中/丢弃辅助 --
    def selection_at_row(self, row_index):
        if 0 <= row_index < len(self.rows):
            row = self.rows[row_index]
            return {"action_index": row.action_index, "split_index": row.split_index}
        return None

    def discard_at_row(self, row_index):
        if not (0 <= row_index < len(self.rows)):
            return False
        row = self.rows[row_index]
        if row.status != "pending":
            return False
        action = self._action(row)
        if action is None:
            return False
        if action["action"] == "modify":
            action["discarded"] = True
        elif action["action"] == "split":
            if row.split_index is None:
                for item in action.get("new_notes") or []:
                    if not item.get("applied"):
                        item["discarded"] = True
            else:
                new_notes = action.get("new_notes") or []
                if 0 <= row.split_index < len(new_notes):
                    new_notes[row.split_index]["discarded"] = True
        self.refresh()
        return True

    def pending_selections(self):
        """返回全部未应用且未丢弃的 selection。"""
        selections = []
        for row in self.rows:
            if row.status == "pending":
                selections.append(
                    {"action_index": row.action_index, "split_index": row.split_index}
                )
        return selections
