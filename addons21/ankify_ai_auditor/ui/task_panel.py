"""清洗任务窗口。"""

from aqt.qt import (
    QAbstractItemView,
    QDialog,
    QHBoxLayout,
    QHeaderView,
    QLabel,
    QMessageBox,
    QProgressBar,
    QPushButton,
    QTableView,
    QTimer,
    QVBoxLayout,
)

from . import edit_table

_PANELS = {}


def _set_selection_behavior(table):
    try:
        table.setSelectionBehavior(QAbstractItemView.SelectionBehavior.SelectRows)
    except AttributeError:
        table.setSelectionBehavior(QAbstractItemView.SelectRows)


def _set_selection_mode(table):
    try:
        table.setSelectionMode(QAbstractItemView.SelectionMode.ExtendedSelection)
    except AttributeError:
        table.setSelectionMode(QAbstractItemView.ExtendedSelection)


def _set_edit_triggers(table):
    try:
        table.setEditTriggers(
            QAbstractItemView.EditTrigger.DoubleClicked
            | QAbstractItemView.EditTrigger.EditKeyPressed
            | QAbstractItemView.EditTrigger.SelectedClicked
        )
    except AttributeError:
        table.setEditTriggers(
            QAbstractItemView.DoubleClicked | QAbstractItemView.EditKeyPressed | QAbstractItemView.SelectedClicked
        )


def _set_header_resize_mode(header):
    try:
        header.setSectionResizeMode(QHeaderView.ResizeMode.ResizeToContents)
    except AttributeError:
        header.setSectionResizeMode(QHeaderView.ResizeToContents)


def open_panel(task_manager, tid):
    if tid in _PANELS:
        panel = _PANELS[tid]
        panel.show()
        panel.raise_()
        panel.activateWindow()
        return panel
    panel = TaskPanel(task_manager, tid)
    _PANELS[tid] = panel
    panel.show()
    return panel


def _close_panel(tid):
    _PANELS.pop(tid, None)


class TaskPanel(QDialog):
    def __init__(self, task_manager, tid, parent=None):
        super().__init__(parent)
        self.task_manager = task_manager
        self.tid = tid
        self.setWindowTitle("Ankify AI 清洗任务 %s" % tid)
        self.resize(1100, 600)

        self.status_label = QLabel("状态：准备中")
        self.progress = QProgressBar()
        self.progress.setRange(0, 1)
        self.stats_label = QLabel("统计：-")

        self.model = edit_table.AuditTableModel(task_manager, tid, self)
        self.table = QTableView()
        self.table.setModel(self.model)
        _set_selection_behavior(self.table)
        _set_selection_mode(self.table)
        _set_edit_triggers(self.table)
        _set_header_resize_mode(self.table.horizontalHeader())
        self.table.horizontalHeader().setStretchLastSection(True)

        self.view_mode_btn = QPushButton("切换笔记模式")
        self.view_mode_btn.clicked.connect(self._toggle_view_mode)

        apply_selected_btn = QPushButton("应用选中")
        apply_all_btn = QPushButton("应用全部并关闭")
        discard_btn = QPushButton("丢弃")
        close_window_btn = QPushButton("关闭窗口（后台继续）")
        close_task_btn = QPushButton("关闭任务（归档）")

        apply_selected_btn.clicked.connect(self._apply_selected)
        apply_all_btn.clicked.connect(self._apply_all)
        discard_btn.clicked.connect(self._discard_selected)
        close_window_btn.clicked.connect(self.close)
        close_task_btn.clicked.connect(self._close_task)

        button_row = QHBoxLayout()
        button_row.addWidget(self.view_mode_btn)
        button_row.addWidget(apply_selected_btn)
        button_row.addWidget(discard_btn)
        button_row.addWidget(apply_all_btn)
        button_row.addStretch(1)
        button_row.addWidget(close_window_btn)
        button_row.addWidget(close_task_btn)

        layout = QVBoxLayout()
        layout.addWidget(self.status_label)
        layout.addWidget(self.progress)
        layout.addWidget(self.stats_label)
        layout.addWidget(self.table)
        layout.addLayout(button_row)
        self.setLayout(layout)

        self._timer = QTimer(self)
        self._timer.timeout.connect(self._refresh)
        self._timer.start(500)
        self._refresh()

    # -- 刷新 --
    def _refresh(self):
        task = self.task_manager.get_task(self.tid)
        if task is None:
            return
        status = task["status"]
        total = task["total"] or 1
        processed = task["processed"]
        self.status_label.setText("状态：%s    已跑 %s / %s 张笔记" % (status, processed, task["total"]))
        self.progress.setRange(0, total)
        self.progress.setValue(processed)
        self.stats_label.setText(
            "统计：建议 保留 %s · 修改 %s · 拆解 %s · 失败 %s    已应用：修改笔记 %s · 新建笔记 %s · 新建卡片 %s"
            % (
                task["keep"],
                task["modify"],
                task["split"],
                task["failed"],
                task["modified_notes"],
                task["created_notes"],
                task["created_cards"],
            )
        )
        actions = task.get("actions") or []
        applied_count = sum(1 for action in actions if action.get("applied"))
        discarded_count = sum(1 for action in actions if action.get("discarded"))
        signature = (len(actions), applied_count, discarded_count, task["status"], self.model.view_mode)
        if getattr(self, "_last_signature", None) != signature:
            self._last_signature = signature
            self.model.refresh()
        self.task_manager._update_browser_actions()

    # -- 视图切换 --
    def _toggle_view_mode(self):
        if self.model.view_mode == "card":
            self.model.set_view_mode("note")
            self.view_mode_btn.setText("切换卡片模式")
        else:
            self.model.set_view_mode("card")
            self.view_mode_btn.setText("切换笔记模式")
        self._refresh()

    # -- 选中/应用/丢弃 --
    def _selected_selections(self):
        selections = []
        rows = self.table.selectionModel().selectedRows()
        for index in rows:
            selection = self.model.selection_at_row(index.row())
            if selection is not None and selection not in selections:
                selections.append(selection)
        return selections

    def _apply_selected(self):
        selections = self._selected_selections()
        if not selections:
            return
        task = self.task_manager.get_task(self.tid)
        if task is None:
            return
        if task.get("cfg", {}).get("dry_run"):
            QMessageBox.information(self, "Dry-run", "当前为 dry-run 模式，不会实际写入 Anki。")
            return
        self.task_manager.apply_selected(self.tid, selections)
        self.model.refresh()
        self._refresh()

    def _apply_all(self):
        task = self.task_manager.get_task(self.tid)
        if task is None:
            return
        if task.get("cfg", {}).get("dry_run"):
            QMessageBox.information(self, "Dry-run", "当前为 dry-run 模式，不会实际写入 Anki。")
            return
        selections = self.model.pending_selections()
        if selections:
            self.task_manager.apply_selected(self.tid, selections)
        self.task_manager.archive_task(self.tid)
        self.close()

    def _discard_selected(self):
        rows = self.table.selectionModel().selectedRows()
        changed = False
        for index in rows:
            changed = self.model.discard_at_row(index.row()) or changed
        if changed:
            self.model.refresh()
            self._refresh()

    def _close_task(self):
        self.task_manager.archive_task(self.tid)
        self.close()

    def closeEvent(self, event):
        _close_panel(self.tid)
        super().closeEvent(event)
