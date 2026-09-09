"""Ankify AI Auditor: 在 Browser 中清洗已有 Anki notes。"""

import os
import time

from aqt import gui_hooks
from aqt.qt import QAction, QToolBar, Qt

from . import task_manager

TM = task_manager.TaskManager()


def _debug(msg):
    """写调试日志到插件 logs/debug.log，便于排查按钮/动作挂载问题。"""
    try:
        log_dir = os.path.join(os.path.dirname(__file__), "logs")
        os.makedirs(log_dir, exist_ok=True)
        with open(os.path.join(log_dir, "debug.log"), "a", encoding="utf-8") as fh:
            fh.write(time.strftime("%Y-%m-%d %H:%M:%S") + " " + str(msg) + "\n")
    except Exception:
        pass


def _top_toolbar_area():
    try:
        return Qt.ToolBarArea.TopToolBarArea
    except AttributeError:
        return Qt.TopToolBarArea


def _ensure_browser_toolbar(browser):
    """创建一个可见的顶部 QToolBar（部分 Anki 版本 Browser 没有现成 toolbar）。"""
    toolbar = getattr(browser, "_ankify_ai_toolbar", None)
    if toolbar is not None:
        return toolbar
    toolbar = QToolBar("Ankify AI", browser)
    toolbar.setObjectName("ankify-ai-toolbar")
    try:
        browser.addToolBar(_top_toolbar_area(), toolbar)
    except Exception:
        pass
    browser._ankify_ai_toolbar = toolbar
    return toolbar


def _add_action(browser, action):
    """按版本兼容顺序加入 Browser 顶部工具栏；最终退化为菜单栏。"""
    try:
        toolbar = getattr(browser.form, "toolbar", None)
        if toolbar is not None:
            toolbar.addAction(action)
            _debug("action %s -> browser.form.toolbar" % action.text())
            return
    except Exception as exc:
        _debug("form.toolbar error: %s" % exc)
    try:
        toolbar = _ensure_browser_toolbar(browser)
        toolbar.addAction(action)
        _debug("action %s -> own top toolbar" % action.text())
        return
    except Exception as exc:
        _debug("own toolbar error: %s" % exc)
    try:
        sidebar = getattr(browser, "sidebar", None)
        toolbar = getattr(sidebar, "toolbar", None)
        if toolbar is not None:
            toolbar.addAction(action)
            _debug("action %s -> sidebar.toolbar" % action.text())
            return
    except Exception as exc:
        _debug("sidebar.toolbar error: %s" % exc)
    menu = getattr(browser.form, "menuTools", None)
    if menu is not None:
        menu.addAction(action)
        _debug("action %s -> menuTools" % action.text())
        return
    try:
        browser.menuBar().addAction(action)
        _debug("action %s -> menuBar" % action.text())
    except Exception as exc:
        _debug("menuBar error: %s" % exc)


def _selected_payloads(browser):
    from . import config as config_mod
    from . import note_repo

    nids = note_repo.selected_note_ids(browser)
    if not nids:
        return []
    cfg = config_mod.get_config()
    payloads = note_repo.extract_payloads_from_nids(nids)

    locked_tag = cfg.get("locked_tag") or "ankify-ai::locked"
    excluded = cfg.get("exclude_decks") or []
    filtered = []
    for p in payloads:
        if locked_tag in (p.get("tags") or []):
            continue
        decks = p.get("decks") or []
        if excluded and any(any(d.startswith(prefix) for prefix in excluded) for d in decks):
            continue
        filtered.append(p)
    return filtered


def _on_clean(browser):
    payloads = _selected_payloads(browser)
    if not payloads:
        return
    from . import ankifyd_client
    from . import config as config_mod

    error = ankifyd_client.preflight_error()
    if error:
        _notify_preflight_error(browser, error)
        return
    cfg = config_mod.get_config()
    TM.start_batch(payloads, cfg)


def _on_open_task(browser):
    TM.open_panel()


def _notify_preflight_error(browser, message):
    from aqt.utils import tooltip

    tooltip("Ankify AI: %s" % message, parent=browser)


def _on_browser_menus_did_init(browser):
    _debug("browser_menus_did_init fired")
    clean_action = QAction("清洗", browser)
    clean_action.setToolTip("选中笔记后，交给 AI 审计并生成清洗建议")
    clean_action.triggered.connect(lambda: _on_clean(browser))
    _add_action(browser, clean_action)

    task_action = QAction("清洗任务", browser)
    task_action.setToolTip("打开最近一个清洗任务窗口")
    task_action.triggered.connect(lambda: _on_open_task(browser))
    _add_action(browser, task_action)
    TM.register_browser_action(task_action)


gui_hooks.browser_menus_did_init.append(_on_browser_menus_did_init)
