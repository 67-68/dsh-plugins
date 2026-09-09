"""ankifyd 客户端：Anki 插件与本地服务通信。

Anki 插件只做薄壳 + UI；真正的 core 加载、prompt 组装、API 调用、Schema 校验都在 ankifyd 服务内完成。
"""

import json
import os
import secrets
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

DEFAULT_CONFIG_PATH = "~/.config/ankify-ai/config.json"
DEFAULT_HOME = "~/.local/share/ankify-ai"
DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8766
DEFAULT_TIMEOUT = 180

# ankifyd 是 localhost 服务；macOS 上 urllib 默认会走系统代理，必须显式关掉。
_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class AnkifydError(RuntimeError):
    """ankifyd 不可用或调用失败。"""


def _expand(path: str) -> str:
    return os.path.expanduser(os.path.expandvars(path or ""))


def _ensure_parent(path: str):
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)


def config_path() -> str:
    return _expand(os.environ.get("ANKIFY_AI_CONFIG", DEFAULT_CONFIG_PATH))


def home_path() -> str:
    return _expand(os.environ.get("ANKIFY_AI_HOME", DEFAULT_HOME))


def daemon_path() -> str:
    explicit = os.environ.get("ANKIFY_AI_DAEMON", "").strip()
    if explicit:
        return _expand(explicit)
    return os.path.join(home_path(), "ankifyd.py")


def _default_config():
    return {
        "version": 1,
        "host": DEFAULT_HOST,
        "port": DEFAULT_PORT,
        "token": secrets.token_urlsafe(32),
        "api_endpoint": "https://api.deepseek.com/chat/completions",
        "api_key": "",
        "api_key_file": "",
        "models": {
            "text": "deepseek-chat",
            "vision": "deepseek-chat",
            "audit": "deepseek-chat",
        },
        "temperature": 0,
        "timeout_seconds": DEFAULT_TIMEOUT,
        "max_retries": 3,
        "idle_timeout_seconds": 0,
    }


def _write_json(path: str, obj):
    _ensure_parent(path)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    os.replace(tmp, path)


def load_config():
    """读取集中配置；不存在则创建默认配置。"""
    path = config_path()
    if os.path.exists(path):
        with open(path, "r", encoding="utf-8") as fh:
            return json.load(fh)
    cfg = _default_config()
    _write_json(path, cfg)
    return cfg


def save_config(cfg):
    _write_json(config_path(), cfg)


def _base_url(cfg):
    host = (cfg.get("host") or DEFAULT_HOST).strip()
    port = int(cfg.get("port") or DEFAULT_PORT)
    return "http://%s:%s" % (host, port)


def _headers(cfg):
    return {
        "Content-Type": "application/json",
        "Authorization": "Bearer " + str(cfg.get("token") or ""),
    }


def _parse_error(exc):
    try:
        body = exc.read().decode("utf-8", errors="ignore")
    except Exception:
        return ""
    try:
        obj = json.loads(body)
        return (obj.get("error") or {}).get("message") or body[:300]
    except Exception:
        return body[:300]


def health(cfg=None):
    cfg = cfg or load_config()
    try:
        request = urllib.request.Request(
            _base_url(cfg) + "/health",
            headers=_headers(cfg),
            method="GET",
        )
        with _OPENER.open(request, timeout=2) as response:
            return json.loads(response.read().decode("utf-8"))
    except Exception:
        return None


def _start_daemon(cfg):
    daemon = daemon_path()
    if not os.path.isfile(daemon):
        raise AnkifydError(
            "未找到 ankifyd 服务文件：%s\n请先运行 dsh-plugins/install.sh 部署 ankifyd 与 core。" % daemon
        )
    python = shutil.which("python3") or sys.executable
    if not python:
        raise AnkifydError("找不到 python3，无法启动 ankifyd")

    log_dir = os.path.join(home_path(), "logs")
    os.makedirs(log_dir, exist_ok=True)
    stdout_path = os.path.join(log_dir, "ankifyd-client.log")
    stdout = open(stdout_path, "ab", buffering=0)

    try:
        subprocess.Popen(
            [python, daemon, "--config", config_path(), "--core-dir", os.path.join(home_path(), "core")],
            stdout=stdout,
            stderr=subprocess.STDOUT,
            stdin=subprocess.DEVNULL,
            start_new_session=True,
        )
    except Exception as exc:
        raise AnkifydError("启动 ankifyd 失败：%s" % exc) from None


def _log(msg):
    try:
        log_dir = os.path.join(home_path(), "logs")
        os.makedirs(log_dir, exist_ok=True)
        with open(os.path.join(log_dir, "ankifyd-client.log"), "a", encoding="utf-8") as fh:
            fh.write(time.strftime("%Y-%m-%d %H:%M:%S") + " " + str(msg) + "\n")
    except Exception:
        pass


def _deployed_core_version():
    try:
        with open(os.path.join(home_path(), "core", "VERSION"), "r", encoding="utf-8") as fh:
            return fh.read().strip()
    except Exception:
        return None


def _warn_version_mismatch(info):
    deployed = _deployed_core_version()
    daemon_version = (info or {}).get("core_version")
    if deployed and daemon_version and deployed != daemon_version:
        _log("core 版本不匹配：部署目录=%s，ankifyd 加载=%s" % (deployed, daemon_version))


def ensure_daemon(cfg=None, timeout_seconds=12):
    """确保 daemon 在运行；不在则拉起并等待健康。"""
    cfg = cfg or load_config()
    info = health(cfg)
    if info is not None:
        _warn_version_mismatch(info)
        return cfg

    _start_daemon(cfg)

    deadline = time.time() + timeout_seconds
    last_error = None
    while time.time() < deadline:
        time.sleep(0.4)
        info = health(cfg)
        if info is not None:
            _warn_version_mismatch(info)
            return cfg
        last_error = "health check 未通过"
    raise AnkifydError(
        "ankifyd 启动超时（%s）。请查看日志：%s"
        % (last_error, os.path.join(home_path(), "logs", "ankifyd.log"))
    )


def _request(method, path, body=None, cfg=None):
    cfg = cfg or load_config()
    if health(cfg) is None:
        ensure_daemon(cfg)
    data = json.dumps(body, ensure_ascii=False).encode("utf-8") if body is not None else None
    request = urllib.request.Request(
        _base_url(cfg) + path,
        data=data,
        headers=_headers(cfg),
        method=method,
    )
    try:
        with _OPENER.open(request, timeout=int(cfg.get("timeout_seconds") or DEFAULT_TIMEOUT)) as response:
            return json.loads(response.read().decode("utf-8"))
    except urllib.error.HTTPError as exc:
        message = _parse_error(exc)
        raise AnkifydError("ankifyd HTTP %s: %s" % (exc.code, message)) from None
    except urllib.error.URLError as exc:
        raise AnkifydError("无法连接 ankifyd：%s" % exc) from None
    except Exception as exc:
        raise AnkifydError("调用 ankifyd 失败：%s" % exc) from None


def audit(notes):
    """调用 /v1/audit，返回 {"actions": [...], "keep_count": N}。"""
    return _request("POST", "/v1/audit", {"notes": notes})


def classify(text, background=""):
    """调用 /v1/classify（未来 Raycast 使用）。"""
    return _request("POST", "/v1/classify", {"text": text, "background": background})


def ankify(body):
    """调用 /v1/ankify（未来 Raycast 使用）。body 为 {"kind":"text"|"image", ...}。"""
    return _request("POST", "/v1/ankify", body)


def preflight_error():
    """返回用户可读的预检错误；一切就绪返回 None。"""
    if not os.path.isfile(daemon_path()):
        return "未找到 ankifyd 服务文件：%s。请先运行 dsh-plugins/install.sh。" % daemon_path()
    try:
        load_config()
    except Exception as exc:
        return "读取集中配置失败：%s" % exc
    return None
