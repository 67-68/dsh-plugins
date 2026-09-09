"""交易日志：保存每次写回前的原值，便于人工回滚。"""

import datetime
import json
import os

LOG_DIR = os.path.join(os.path.dirname(__file__), "logs")


def log_transaction(entry):
    os.makedirs(LOG_DIR, exist_ok=True)
    path = os.path.join(LOG_DIR, "transactions-%s.jsonl" % datetime.date.today().isoformat())
    entry = dict(entry)
    entry["time"] = datetime.datetime.now().isoformat(timespec="seconds")
    with open(path, "a", encoding="utf-8") as fh:
        fh.write(json.dumps(entry, ensure_ascii=False) + "\n")
    return path
