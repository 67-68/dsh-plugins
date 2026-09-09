"""后台任务管理：分批调用 AI，收集动作，维护统计。"""

import queue
import threading

from aqt.qt import QTimer


class TaskManager:
    def __init__(self):
        self.tasks = {}
        self.archived_tasks = {}
        self.next_task_id = 1
        self.browser_actions = []
        self._lock = threading.Lock()

    # -- 注册 Browser 入口，用于显示进度 --
    def register_browser_action(self, action):
        with self._lock:
            if action not in self.browser_actions:
                self.browser_actions.append(action)
        self._update_browser_actions()

    def _update_browser_actions(self):
        latest = self.latest_task()
        for action in list(self.browser_actions):
            try:
                if latest is None:
                    action.setText("清洗任务")
                    action.setEnabled(False)
                else:
                    tid = latest["id"]
                    total = latest["total"]
                    processed = latest["processed"]
                    status = latest["status"]
                    action.setText("清洗任务 %s · %s/%s %s" % (tid, processed, total, status))
                    action.setEnabled(True)
            except Exception:
                pass

    def _emit_main_thread(self, fn):
        try:
            from aqt import mw

            runner = getattr(mw, "taskman", None)
            if runner is not None and hasattr(runner, "run_on_main"):
                runner.run_on_main(fn)
                return
        except Exception:
            pass
        QTimer.singleShot(0, fn)

    # -- 任务生命周期 --
    def create_task(self, total, cfg):
        with self._lock:
            tid = self.next_task_id
            self.next_task_id += 1
        task = {
            "id": tid,
            "status": "running",
            "total": total,
            "processed": 0,
            "keep": 0,
            "modify": 0,
            "split": 0,
            "failed": 0,
            "modified_notes": 0,
            "created_notes": 0,
            "created_cards": 0,
            "actions": [],
            "queue": queue.Queue(),
            "cfg": cfg,
        }
        with self._lock:
            self.tasks[tid] = task
        return tid

    def get_task(self, tid):
        with self._lock:
            return self.tasks.get(tid)

    def latest_task(self):
        """最近一个未归档任务。"""
        with self._lock:
            active = [t for t in self.tasks.values() if t.get("status") != "archived"]
            if not active:
                return None
            return max(active, key=lambda t: t["id"])

    def latest_task_id(self):
        latest = self.latest_task()
        return latest["id"] if latest else None

    def open_panel(self, tid=None):
        tid = tid or self.latest_task_id()
        if tid is None:
            return
        from .ui import task_panel

        task_panel.open_panel(self, tid)

    def archive_task(self, tid):
        """完全结束任务：停止后台、移入 archive、不再作为活跃任务显示。"""
        task = self.get_task(tid)
        if task is None:
            return False
        with self._lock:
            task["cancel_requested"] = True
            task["status"] = "archived"
            self.archived_tasks[tid] = task
        self._emit_main_thread(self._update_browser_actions)
        return True

    def start_batch(self, payloads, cfg):
        if not payloads:
            return None
        tid = self.create_task(len(payloads), cfg)
        self.open_panel(tid)
        thread = threading.Thread(target=self._worker, args=(tid, payloads, cfg), daemon=True)
        thread.start()
        return tid

    # -- 后台执行 --
    def _worker(self, tid, payloads, cfg):
        from . import ankifyd_client

        task = self.get_task(tid)
        if task is None:
            return
        batch_size = int(cfg.get("batch_size") or 10)
        if batch_size <= 0:
            batch_size = 10

        for start in range(0, len(payloads), batch_size):
            with self._lock:
                if task.get("cancel_requested"):
                    break
            batch = payloads[start : start + batch_size]
            try:
                result = ankifyd_client.audit(batch)
                actions = result.get("actions") or []
                keep_count = int(result.get("keep_count") or 0)
            except Exception:
                actions = []
                with self._lock:
                    task["failed"] += len(batch)
                    task["processed"] += len(batch)
                continue

            with self._lock:
                task["processed"] += len(batch)
                task["keep"] += max(keep_count, 0)
                for action in actions:
                    if action["action"] == "modify":
                        task["modify"] += 1
                    elif action["action"] == "split":
                        task["split"] += 1
                task["actions"].extend(actions)
            for action in actions:
                task["queue"].put(action)

        with self._lock:
            if not task.get("cancel_requested"):
                task["status"] = "done"
        task["queue"].put(None)
        self._emit_main_thread(self._update_browser_actions)

    # -- 应用动作 --
    def apply_actions(self, tid, indices):
        """兼容旧调用：按 action 维度应用全部未应用、未丢弃内容。"""
        selections = [{"action_index": i, "split_index": None} for i in indices]
        return self.apply_selected(tid, selections)

    def apply_selected(self, tid, selections):
        from . import note_repo

        task = self.get_task(tid)
        if task is None:
            return False
        cfg = task.get("cfg") or {}
        if cfg.get("dry_run"):
            return False

        applied_any = False
        actions = task.get("actions") or []
        for selection in selections:
            action_index = selection.get("action_index")
            split_index = selection.get("split_index")
            if action_index is None or not (0 <= action_index < len(actions)):
                continue
            action = actions[action_index]

            if action.get("discarded"):
                continue

            if action["action"] == "modify":
                if action.get("applied"):
                    continue
                result = note_repo.apply_action(action, cfg)
                action["applied"] = True
            elif action["action"] == "split":
                new_notes = action.get("new_notes") or []
                if split_index is None:
                    target_indices = [
                        i for i, item in enumerate(new_notes)
                        if not item.get("applied") and not item.get("discarded")
                    ]
                else:
                    if split_index < 0 or split_index >= len(new_notes):
                        continue
                    item = new_notes[split_index]
                    if item.get("applied") or item.get("discarded"):
                        continue
                    target_indices = [split_index]
                if not target_indices:
                    continue
                result = note_repo.apply_action(action, cfg, split_indices=target_indices)
                if all(n.get("applied") or n.get("discarded") for n in new_notes):
                    action["applied"] = True
            else:
                continue

            with self._lock:
                task["modified_notes"] += result.get("modified_notes", 0)
                task["created_notes"] += result.get("created_notes", 0)
                task["created_cards"] += result.get("created_cards", 0)
            applied_any = True

        if applied_any:
            self._emit_main_thread(self._update_browser_actions)
        return applied_any
