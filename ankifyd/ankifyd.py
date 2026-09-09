#!/usr/bin/env python3
# -*- coding: utf-8 -*-
"""ankifyd：Ankify AI 本地服务。

职责：
- 唯一持有 ankify-ai-core（policy / prompts / schemas / examples）
- 唯一持有 OpenAI 兼容 API 配置（endpoint / key / models / retries）
- 对外暴露三个能力：/v1/classify、/v1/ankify、/v1/audit

消费端：
- Anki 插件：只调用 /v1/audit，把返回 actions 渲染到 UI 并写回 Anki。
- Raycast 插件（未来）：调用 /v1/classify 与 /v1/ankify，再本地渲染 Markdown。
"""

import argparse
import json
import os
import re
import secrets
import sys
import time
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import urlsplit

SERVICE_NAME = "ankifyd"
SERVICE_VERSION = "0.1.0"

DEFAULT_HOST = "127.0.0.1"
DEFAULT_PORT = 8766
DEFAULT_CONFIG_PATH = "~/.config/ankify-ai/config.json"
DEFAULT_HOME = "~/.local/share/ankify-ai"

TYPE_ENUM = {"A1", "A2", "A3", "A4", "B1", "B2", "B3", "B4", "B5", "B6", "B7", "B8"}
COMPLEXITY_ENUM = {"atomic", "structural", "mixed"}
PIPELINE_ENUM = {"single-pass", "two-pass"}

# macOS 上 urllib 默认会走系统代理；本地 mock/自建服务需要显式绕开。
_NO_PROXY_OPENER = urllib.request.build_opener(urllib.request.ProxyHandler({}))


def _is_local_endpoint(endpoint: str) -> bool:
    host = (urlsplit(endpoint).hostname or "").lower()
    return host in ("127.0.0.1", "localhost", "::1")


def _expand(path: str) -> str:
    return os.path.expanduser(os.path.expandvars(path or ""))


def _ensure_parent(path: str):
    parent = os.path.dirname(path)
    if parent:
        os.makedirs(parent, exist_ok=True)


def _read_json(path: str):
    with open(path, "r", encoding="utf-8") as fh:
        return json.load(fh)


def _write_json(path: str, obj):
    _ensure_parent(path)
    tmp = path + ".tmp"
    with open(tmp, "w", encoding="utf-8") as fh:
        json.dump(obj, fh, ensure_ascii=False, indent=2)
        fh.write("\n")
    os.replace(tmp, path)


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
        "timeout_seconds": 180,
        "max_retries": 3,
        "idle_timeout_seconds": 0,
    }


def _default_config_path() -> str:
    return _expand(os.environ.get("ANKIFY_AI_CONFIG", DEFAULT_CONFIG_PATH))


def _default_home() -> str:
    return _expand(os.environ.get("ANKIFY_AI_HOME", DEFAULT_HOME))


def load_config(path: str = None):
    """读取集中配置；不存在则创建默认配置。"""
    path = _expand(path or _default_config_path())
    if os.path.exists(path):
        cfg = _read_json(path)
    else:
        cfg = _default_config()
        _write_json(path, cfg)
    return path, cfg


def locate_core_dir(explicit: str = None) -> str:
    """定位 ankify-ai-core 目录。"""
    candidates = []
    if explicit:
        candidates.append(_expand(explicit))
    candidates.append(os.path.join(_default_home(), "core"))
    here = os.path.dirname(os.path.abspath(__file__))
    candidates.append(os.path.join(here, "core"))
    candidates.append(os.path.abspath(os.path.join(here, "..", "ankify-ai-core")))
    for candidate in candidates:
        if candidate and os.path.isfile(os.path.join(candidate, "VERSION")):
            return os.path.abspath(candidate)
    raise RuntimeError(
        "找不到 ankify-ai-core，请确认已执行 dsh-plugins/install.sh，或使用 --core-dir 指定目录"
    )


def core_version(core_dir: str) -> str:
    try:
        with open(os.path.join(core_dir, "VERSION"), "r", encoding="utf-8") as fh:
            return fh.read().strip()
    except FileNotFoundError:
        return "unknown"


def read_core(core_dir: str, *parts) -> str:
    with open(os.path.join(core_dir, *parts), "r", encoding="utf-8") as fh:
        return fh.read()


def load_json_core(core_dir: str, *parts):
    with open(os.path.join(core_dir, *parts), "r", encoding="utf-8") as fh:
        return json.load(fh)


# ---------------------------------------------------------------------------
# API key 解析
# ---------------------------------------------------------------------------

_KEY_EXPORT_RE = [
    re.compile(r'(?:export\s+)?DEEPSEEK_API_KEY\s*=\s*["\']([^"\']+)["\']'),
    re.compile(r'(?:export\s+)?DEEPSEEK_API_KEY\s*=\s*([^\s]+)'),
    re.compile(r'(?:export\s+)?OPENAI_API_KEY\s*=\s*["\']([^"\']+)["\']'),
    re.compile(r'(?:export\s+)?OPENAI_API_KEY\s*=\s*([^\s]+)'),
]


def _extract_key_from_text(content: str):
    content = content.strip()
    if content.startswith("sk-") and "=" not in content:
        return content
    for regex in _KEY_EXPORT_RE:
        match = regex.search(content)
        if match:
            return match.group(1).strip()
    return None


def _read_key_file(path: str):
    path = _expand(path)
    try:
        with open(path, "r", encoding="utf-8") as fh:
            return _extract_key_from_text(fh.read())
    except Exception:
        return None


def resolve_api_key(cfg):
    key = (cfg.get("api_key") or "").strip()
    if key:
        return key

    for env_name in ("DEEPSEEK_API_KEY", "OPENAI_API_KEY"):
        env = os.environ.get(env_name, "").strip()
        if env:
            return env

    key_file = (cfg.get("api_key_file") or "").strip()
    if key_file:
        key = _read_key_file(key_file)
        if key:
            return key

    for shell_file in ("~/.zshrc", "~/.zshenv", "~/.bashrc", "~/.bash_profile", "~/.profile"):
        key = _read_key_file(shell_file)
        if key:
            return key
    return ""


# ---------------------------------------------------------------------------
# Prompt 组装
# ---------------------------------------------------------------------------

def build_system_prompt(core_dir: str, task_file: str) -> str:
    return (
        read_core(core_dir, "prompts", "system-core.md")
        + "\n\n"
        + read_core(core_dir, "policy.md")
        + "\n\n"
        + read_core(core_dir, "prompts", task_file)
    )


def _format_background(background: str) -> str:
    return background.strip() or "未提供"


def build_classify_messages(core_dir: str, body):
    text = body.get("text") or ""
    background = _format_background(body.get("background") or "")
    system = build_system_prompt(core_dir, "task-classify.md")
    user = "背景/上下文（用户提供）：%s\n\n以下是需要分类的文本：\n---\n%s\n---" % (background, text)
    return system, user


def build_ankify_messages(core_dir: str, body):
    kind = body.get("kind") or "text"
    background = _format_background(body.get("background") or "")
    system = build_system_prompt(core_dir, "task-ankify.md")

    if kind == "image":
        base64 = body.get("image_base64") or ""
        if not base64:
            raise ValueError("image_base64 为空")
        mime_type = body.get("mime_type") or "image/png"
        user_text = (
            "背景/上下文（用户提供）：%s\n\n"
            "用户提供的是一张图片。请先识别图片中的文字，"
            "再按照系统要求清洗为 Anki 卡片 JSON。" % background
        )
        user = [
            {"type": "text", "text": user_text},
            {"type": "image_url", "image_url": {"url": "data:%s;base64,%s" % (mime_type, base64)}},
        ]
        return system, user

    text = body.get("text") or ""
    if not text:
        raise ValueError("text 为空")
    classify = body.get("classify")
    if classify:
        user = (
            "背景/上下文（用户提供）：%s\n\n"
            "这是 two-pass 模式的第二轮。第一轮分类结果如下：\n%s\n\n"
            "以下是需要制卡的文本：\n---\n%s\n---"
            % (background, json.dumps(classify, ensure_ascii=False, indent=2), text)
        )
    else:
        user = "背景/上下文（用户提供）：%s\n\n以下是需要制卡的文本：\n---\n%s\n---" % (background, text)
    return system, user


def build_audit_messages(core_dir: str, notes):
    system = build_system_prompt(core_dir, "task-audit.md")
    user = json.dumps(notes, ensure_ascii=False, indent=2)
    tools = load_json_core(core_dir, "schemas", "audit_tools.json")
    return system, user, tools


# ---------------------------------------------------------------------------
# OpenAI 兼容调用
# ---------------------------------------------------------------------------

def call_chat_completion(cfg, messages, tools=None, model=None, json_mode=False):
    endpoint = (cfg.get("api_endpoint") or "").strip() or "https://api.deepseek.com/chat/completions"
    api_key = resolve_api_key(cfg)
    if not api_key:
        raise RuntimeError(
            "api_key 为空：请在 ~/.config/ankify-ai/config.json 中配置 api_key，"
            "或设置 DEEPSEEK_API_KEY / OPENAI_API_KEY 环境变量"
        )
    if model is None:
        model = (cfg.get("models") or {}).get("text") or "deepseek-chat"

    payload = {
        "model": model,
        "temperature": float(cfg.get("temperature") if cfg.get("temperature") is not None else 0),
        "messages": messages,
    }
    if tools:
        payload["tools"] = tools
        payload["tool_choice"] = "auto"
    if json_mode:
        payload["response_format"] = {"type": "json_object"}

    data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
    timeout = int(cfg.get("timeout_seconds") or 180)
    max_retries = int(cfg.get("max_retries") or 3)
    last_error = None

    for attempt in range(max_retries):
        try:
            request = urllib.request.Request(
                endpoint,
                data=data,
                headers={
                    "Content-Type": "application/json",
                    "Authorization": "Bearer " + api_key,
                },
                method="POST",
            )
            if _is_local_endpoint(endpoint):
                response = _NO_PROXY_OPENER.open(request, timeout=timeout)
            else:
                response = urllib.request.urlopen(request, timeout=timeout)
            with response:
                return json.loads(response.read().decode("utf-8"))
        except urllib.error.HTTPError as exc:
            last_error = exc
            body = exc.read().decode("utf-8", errors="ignore")
            if exc.code in (429, 500, 502, 503, 504) and attempt < max_retries - 1:
                time.sleep(2 ** attempt)
                continue
            raise RuntimeError("API HTTP %s: %s" % (exc.code, body[:500])) from None
        except Exception as exc:
            last_error = exc
            if attempt < max_retries - 1:
                time.sleep(2 ** attempt)
                continue
    raise RuntimeError("API 调用失败: %s" % last_error)


def _parse_json_content(content: str):
    """从模型返回的 content 中解析 JSON（容忍 markdown code fence）。"""
    text = (content or "").strip()
    if not text:
        raise ValueError("模型返回内容为空")
    try:
        return json.loads(text)
    except json.JSONDecodeError:
        pass
    # 去掉 ```json ... ``` 围栏
    match = re.search(r"```(?:json)?\s*\n?(.*?)\n?```", text, re.S)
    if match:
        try:
            return json.loads(match.group(1))
        except json.JSONDecodeError:
            pass
    # 取第一个 { 到最后一个 } 之间的内容
    start = text.find("{")
    end = text.rfind("}")
    if start >= 0 and end > start:
        try:
            return json.loads(text[start : end + 1])
        except json.JSONDecodeError:
            pass
    raise ValueError("模型返回的不是合法 JSON")


def _response_message(response):
    try:
        return response["choices"][0]["message"]
    except (KeyError, IndexError, TypeError) as exc:
        raise ValueError("API 响应缺少 choices[0].message: %s" % exc) from None


# ---------------------------------------------------------------------------
# 校验
# ---------------------------------------------------------------------------

def _check_type(value, where: str):
    if value and value not in TYPE_ENUM:
        raise ValueError("%s: 类型 %s 不在 A1-B8 枚举中" % (where, value))


def validate_card(card, where: str):
    if not isinstance(card, dict):
        raise ValueError("%s: 卡片不是对象" % where)
    front = card.get("front")
    back = card.get("back")
    if not isinstance(front, str) or not front.strip():
        raise ValueError("%s: front 为空" % where)
    if not isinstance(back, str) or not back.strip():
        raise ValueError("%s: back 为空" % where)
    _check_type(card.get("type"), where)
    return True


def validate_ankify_result(obj):
    if not isinstance(obj, dict):
        raise ValueError("ankify 结果不是 JSON 对象")
    cards = obj.get("cards")
    if not isinstance(cards, list) or not cards:
        raise ValueError("ankify 结果 cards 为空或不是数组")
    pipeline = obj.get("pipeline")
    if pipeline not in PIPELINE_ENUM:
        raise ValueError("ankify 结果 pipeline 不是 single-pass/two-pass")
    for index, card in enumerate(cards):
        validate_card(card, "cards[%s]" % index)
    return obj


def validate_classify_result(obj):
    if not isinstance(obj, dict):
        raise ValueError("classify 结果不是 JSON 对象")
    types = obj.get("types")
    if not isinstance(types, list) or not types:
        raise ValueError("classify 结果 types 为空或不是数组")
    for type_hint in types:
        if type_hint not in TYPE_ENUM:
            raise ValueError("classify 结果 types 包含非法类型: %s" % type_hint)
    if obj.get("complexity") not in COMPLEXITY_ENUM:
        raise ValueError("classify 结果 complexity 非法")
    if obj.get("pipeline") not in PIPELINE_ENUM:
        raise ValueError("classify 结果 pipeline 非法")
    return obj


def parse_audit_response(response, notes):
    """把 OpenAI 响应解析为 action 列表；keep 不产生 action。"""
    message = _response_message(response)
    actions = []
    guid_index = {payload["guid"]: payload for payload in notes}

    for tool_call in message.get("tool_calls") or []:
        fn = tool_call.get("function") or {}
        name = fn.get("name")
        if name not in ("modify_note", "split_note"):
            continue
        try:
            args = json.loads(fn.get("arguments") or "{}")
        except json.JSONDecodeError as exc:
            raise ValueError("tool call arguments 不是合法 JSON: %s" % exc) from None

        note_guid = args.get("note_guid")
        payload = guid_index.get(note_guid)
        if payload is None:
            raise ValueError("note_guid %s 不在本批次中" % note_guid)

        valid_keys = set((payload.get("fields") or {}).keys())
        reason = str(args.get("reason") or "")

        def check_fields(fields, where):
            if not isinstance(fields, dict) or not fields:
                raise ValueError("%s: fields 为空或不是对象" % where)
            for key in fields:
                if key not in valid_keys:
                    raise ValueError("%s: 字段名 %s 不在原 note 字段 %s 中" % (where, key, sorted(valid_keys)))

        if name == "modify_note":
            fields = args.get("fields") or {}
            check_fields(fields, "modify_note")
            _check_type(args.get("type_hint"), "modify_note")
            actions.append(
                {
                    "action": "modify",
                    "guid": note_guid,
                    "nid": payload["id"],
                    "original": payload,
                    "fields": fields,
                    "type_hint": args.get("type_hint"),
                    "reason": reason,
                    "reset_scheduling": bool(args.get("reset_scheduling", False)),
                    "new_notes": None,
                    "tags": None,
                    "applied": False,
                }
            )
        elif name == "split_note":
            new_notes = args.get("new_notes") or []
            if not isinstance(new_notes, list) or len(new_notes) < 2:
                raise ValueError("split_note: new_notes 至少 2 条")
            cleaned = []
            for item in new_notes:
                item_fields = item.get("fields") or {}
                check_fields(item_fields, "split_note")
                _check_type(item.get("type_hint"), "split_note")
                cleaned.append(
                    {
                        "fields": item_fields,
                        "type_hint": item.get("type_hint"),
                        "tags": item.get("tags") or [],
                    }
                )
            actions.append(
                {
                    "action": "split",
                    "guid": note_guid,
                    "nid": payload["id"],
                    "original": payload,
                    "fields": None,
                    "type_hint": None,
                    "reason": reason,
                    "reset_scheduling": False,
                    "new_notes": cleaned,
                    "tags": None,
                    "applied": False,
                }
            )
    return actions


# ---------------------------------------------------------------------------
# HTTP 服务
# ---------------------------------------------------------------------------

class AnkifydServer(ThreadingHTTPServer):
    daemon_threads = True

    def __init__(self, server_address, handler_cls, cfg, core_dir, log_file=None):
        super().__init__(server_address, handler_cls)
        self.cfg = cfg
        self.core_dir = core_dir
        self.log_file = log_file


class ApiHandler(BaseHTTPRequestHandler):
    server_version = SERVICE_NAME + "/" + SERVICE_VERSION

    # -- 基础工具 --
    def _send_json(self, status, obj):
        data = json.dumps(obj, ensure_ascii=False, indent=2).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _send_error(self, status, code, message):
        self._send_json(status, {"error": {"code": code, "message": message}})

    def _read_body(self):
        length = int(self.headers.get("Content-Length") or 0)
        if length <= 0:
            return {}
        raw = self.rfile.read(length)
        try:
            return json.loads(raw.decode("utf-8"))
        except json.JSONDecodeError as exc:
            raise ValueError("请求 body 不是合法 JSON: %s" % exc) from None

    def _authorized(self):
        auth = self.headers.get("Authorization") or ""
        token = self.server.cfg.get("token") or ""
        return auth == "Bearer " + token

    def _log(self, msg):
        try:
            if self.server.log_file:
                with open(self.server.log_file, "a", encoding="utf-8") as fh:
                    fh.write(time.strftime("%Y-%m-%d %H:%M:%S") + " " + str(msg) + "\n")
        except Exception:
            pass

    # -- 路由 --
    def do_GET(self):
        if not self._authorized():
            self._send_error(401, "unauthorized", "token 不匹配")
            return
        if self.path == "/health":
            self._handle_health()
        else:
            self._send_error(404, "not_found", "未知路径: %s" % self.path)

    def do_POST(self):
        try:
            if not self._authorized():
                self._send_error(401, "unauthorized", "token 不匹配")
                return
            body = self._read_body()
            if self.path == "/v1/classify":
                self._handle_classify(body)
            elif self.path == "/v1/ankify":
                self._handle_ankify(body)
            elif self.path == "/v1/audit":
                self._handle_audit(body)
            else:
                self._send_error(404, "not_found", "未知路径: %s" % self.path)
        except ValueError as exc:
            self._send_error(400, "bad_request", str(exc))
        except Exception as exc:
            self._log("ERROR %s" % exc)
            self._send_error(500, "internal_error", str(exc))

    def _handle_health(self):
        self._send_json(
            200,
            {
                "ok": True,
                "service": SERVICE_NAME,
                "service_version": SERVICE_VERSION,
                "core_version": core_version(self.server.core_dir),
                "models": (self.server.cfg.get("models") or {}),
                "port": self.server.cfg.get("port", DEFAULT_PORT),
            },
        )

    def _handle_classify(self, body):
        system, user = build_classify_messages(self.server.core_dir, body)
        model = (self.server.cfg.get("models") or {}).get("text")
        response = call_chat_completion(
            self.server.cfg,
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            model=model,
            json_mode=True,
        )
        message = _response_message(response)
        result = validate_classify_result(_parse_json_content(message.get("content")))
        self._send_json(200, result)

    def _handle_ankify(self, body):
        system, user = build_ankify_messages(self.server.core_dir, body)
        kind = body.get("kind") or "text"
        models = self.server.cfg.get("models") or {}
        model = models.get("vision") if kind == "image" else models.get("text")
        response = call_chat_completion(
            self.server.cfg,
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            model=model,
            json_mode=True,
        )
        message = _response_message(response)
        result = validate_ankify_result(_parse_json_content(message.get("content")))
        self._send_json(200, result)

    def _handle_audit(self, body):
        notes = body.get("notes") or []
        if not isinstance(notes, list) or not notes:
            raise ValueError("notes 为空或不是数组")
        system, user, tools = build_audit_messages(self.server.core_dir, notes)
        model = (self.server.cfg.get("models") or {}).get("audit")
        response = call_chat_completion(
            self.server.cfg,
            [{"role": "system", "content": system}, {"role": "user", "content": user}],
            tools=tools,
            model=model,
        )
        actions = parse_audit_response(response, notes)
        addressed = {a["guid"] for a in actions}
        self._send_json(200, {"actions": actions, "keep_count": max(len(notes) - len(addressed), 0)})

    def log_message(self, format, *args):
        self._log("%s - %s" % (self.address_string(), format % args))


# ---------------------------------------------------------------------------
# 启动
# ---------------------------------------------------------------------------

def build_server(cfg, core_dir, log_file=None):
    host = cfg.get("host") or DEFAULT_HOST
    port = int(cfg.get("port") or DEFAULT_PORT)
    server = AnkifydServer((host, port), ApiHandler, cfg, core_dir, log_file)
    return server


def run_server(args):
    config_path, cfg = load_config(args.config)
    if args.host:
        cfg["host"] = args.host
    if args.port:
        cfg["port"] = int(args.port)
    if args.token:
        cfg["token"] = args.token
    if args.api_key is not None:
        cfg["api_key"] = args.api_key

    core_dir = locate_core_dir(args.core_dir)
    log_dir = args.log_dir or os.path.join(_default_home(), "logs")
    os.makedirs(log_dir, exist_ok=True)
    log_file = os.path.join(log_dir, "ankifyd.log")

    server = build_server(cfg, core_dir, log_file)
    host = cfg.get("host") or DEFAULT_HOST
    port = int(cfg.get("port") or DEFAULT_PORT)
    print(
        "%s v%s core=%s listening on http://%s:%s"
        % (SERVICE_NAME, SERVICE_VERSION, core_version(core_dir), host, port)
    )
    print("config: %s" % config_path)
    print("log: %s" % log_file)
    try:
        server.serve_forever(poll_interval=0.5)
    except KeyboardInterrupt:
        pass
    finally:
        server.server_close()


def parse_args(argv=None):
    parser = argparse.ArgumentParser(description="Ankify AI 本地服务")
    parser.add_argument("--config", help="集中配置 JSON 路径（默认 ~/.config/ankify-ai/config.json）")
    parser.add_argument("--core-dir", help="ankify-ai-core 目录（默认自动查找）")
    parser.add_argument("--host", help="监听地址（默认 127.0.0.1）")
    parser.add_argument("--port", type=int, help="监听端口（默认 8766）")
    parser.add_argument("--token", help="覆盖配置中的访问 token")
    parser.add_argument("--api-key", help="覆盖配置中的 api_key（仅本次运行）")
    parser.add_argument("--log-dir", help="日志目录（默认 ~/.local/share/ankify-ai/logs）")
    return parser.parse_args(argv)


if __name__ == "__main__":
    run_server(parse_args())
