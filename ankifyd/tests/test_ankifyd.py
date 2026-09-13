"""ankifyd 端到端测试（使用本地 mock OpenAI 兼容服务）。"""

import json
import os
import sys
import tempfile
import threading
import unittest
import urllib.request
from http.server import BaseHTTPRequestHandler, HTTPServer

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

import ankifyd  # noqa: E402

CORE_DIR = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "..", "ankify-ai-core")

NO_PROXY = urllib.request.build_opener(urllib.request.ProxyHandler({}))


class MockOpenAIHandler(BaseHTTPRequestHandler):
    def do_POST(self):
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length).decode("utf-8"))
        system = body.get("messages", [{}])[0].get("content", "")

        if "task-classify" in system:
            result = {
                "types": ["A4", "B3"],
                "complexity": "structural",
                "pipeline": "two-pass",
                "source_summary": "1848 二月革命时间线",
            }
            payload = {"choices": [{"message": {"role": "assistant", "content": json.dumps(result, ensure_ascii=False)}}]}
        elif "task-ankify" in system:
            user_content = body.get("messages", [{}, {}])[1].get("content", "")
            if isinstance(user_content, list):
                user_content = " ".join(part.get("text", "") for part in user_content if isinstance(part, dict))
            if "cloze-test" in str(user_content):
                result = {
                    "cards": [
                        {
                            "format": "cloze-list",
                            "cloze_items": ["item1", "item2", "item3"],
                            "type": "B1",
                            "tags": ["history"],
                            "extra": "连续 cloze 列表",
                        }
                    ],
                    "pipeline": "single-pass",
                    "source_summary": "有限列表",
                }
            else:
                result = {
                    "cards": [
                        {
                            "front": "1848 年 2 月 24 日，国王路易·菲利普做了什么？",
                            "back": "宣布退位",
                            "type": "A4",
                            "tags": ["history"],
                            "extra": "",
                        }
                    ],
                    "pipeline": "single-pass",
                    "source_summary": "1848 二月革命",
                }
            payload = {"choices": [{"message": {"role": "assistant", "content": json.dumps(result, ensure_ascii=False)}}]}
        elif body.get("tools"):
            tool_args = {
                "note_guid": "guid-1",
                "fields": {"Front": "Q: 1848 年 2 月 24 日，国王路易·菲利普做了什么？", "Back": "A: 宣布退位"},
                "reason": "修改为最小信息卡片",
                "type_hint": "A4",
                "reset_scheduling": False,
            }
            tool_calls = [
                {
                    "id": "call-1",
                    "type": "function",
                    "function": {"name": "modify_note", "arguments": json.dumps(tool_args, ensure_ascii=False)},
                }
            ]
            payload = {"choices": [{"message": {"role": "assistant", "content": None, "tool_calls": tool_calls}}]}
        else:
            payload = {"choices": [{"message": {"role": "assistant", "content": "{}"}}]}

        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, format, *args):
        pass


def start_mock_server():
    server = HTTPServer(("127.0.0.1", 0), MockOpenAIHandler)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    return server


def start_ankifyd(mock_server):
    cfg = ankifyd._default_config()
    cfg["api_endpoint"] = "http://127.0.0.1:%s/chat/completions" % mock_server.server_address[1]
    cfg["api_key"] = "test-key"
    cfg["host"] = "127.0.0.1"
    cfg["port"] = 0
    cfg["temperature"] = 0
    cfg["max_retries"] = 1
    log_file = os.path.join(tempfile.gettempdir(), "ankifyd-test-%s.log" % os.getpid())
    server = ankifyd.build_server(cfg, CORE_DIR, log_file)
    thread = threading.Thread(target=server.serve_forever, daemon=True)
    thread.start()
    cfg["port"] = server.server_address[1]
    return server, cfg


def post_json(url, obj, token):
    data = json.dumps(obj, ensure_ascii=False).encode("utf-8")
    request = urllib.request.Request(
        url,
        data=data,
        headers={"Content-Type": "application/json", "Authorization": "Bearer " + token},
        method="POST",
    )
    with NO_PROXY.open(request, timeout=10) as response:
        return json.loads(response.read().decode("utf-8"))


class AnkifydE2ETest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.mock = start_mock_server()
        cls.server, cls.cfg = start_ankifyd(cls.mock)
        cls.base = "http://%s:%s" % (cls.cfg["host"], cls.cfg["port"])

    @classmethod
    def tearDownClass(cls):
        cls.server.shutdown()
        cls.server.server_close()
        cls.mock.shutdown()
        cls.mock.server_close()

    def test_health(self):
        request = urllib.request.Request(
            self.base + "/health", headers={"Authorization": "Bearer " + self.cfg["token"]}, method="GET"
        )
        with NO_PROXY.open(request, timeout=5) as response:
            result = json.loads(response.read().decode("utf-8"))
        self.assertTrue(result["ok"])
        self.assertEqual(result["service"], "ankifyd")
        self.assertIn("bulk-text", result["modes"])

    def test_audit_returns_actions(self):
        notes = [
            {
                "guid": "guid-1",
                "id": 1,
                "model": "Basic",
                "fields": {"Front": "旧问题", "Back": "旧答案"},
                "tags": [],
                "decks": [],
                "card_templates": [],
                "review": {"card_count": 1, "max_interval": 21, "avg_ease": 2.1, "lapses": 6, "reps": 12, "leech": True},
            }
        ]
        result = post_json(self.base + "/v1/audit", {"notes": notes}, self.cfg["token"])
        self.assertEqual(result["keep_count"], 0)
        self.assertEqual(len(result["actions"]), 1)
        self.assertEqual(result["actions"][0]["action"], "modify")
        self.assertEqual(result["actions"][0]["guid"], "guid-1")
        self.assertEqual(result["actions"][0]["nid"], 1)
        self.assertEqual(result["actions"][0]["original"]["guid"], "guid-1")

    def test_audit_keep_is_returned_as_action(self):
        notes = [
            {
                "guid": "keep-guid",
                "id": 42,
                "model": "Basic",
                "fields": {"Front": "好卡", "Back": "好答案"},
                "tags": [],
                "decks": [],
                "card_templates": [],
                "review": {"card_count": 1, "max_interval": 21, "avg_ease": 2.5, "lapses": 0, "reps": 5, "leech": False},
            }
        ]
        response = {"choices": [{"message": {"role": "assistant", "content": None, "tool_calls": []}}]}
        actions = ankifyd.parse_audit_response(response, notes)
        self.assertEqual(len(actions), 1)
        self.assertEqual(actions[0]["action"], "keep")
        self.assertEqual(actions[0]["guid"], "keep-guid")

    def test_ankify_returns_cards(self):
        body = {"kind": "text", "text": "1848 年 2 月 24 日，国王路易·菲利普宣布退位。", "background": "历史"}
        result = post_json(self.base + "/v1/ankify", body, self.cfg["token"])
        self.assertEqual(len(result["cards"]), 1)
        self.assertEqual(result["cards"][0]["type"], "A4")

    def test_ankify_bulk_text_cloze_list(self):
        body = {
            "kind": "text",
            "mode": "bulk-text",
            "text": "cloze-test: 有限列表按顺序排列",
            "background": "**重点** 之外的文字只是上下文",
        }
        result = post_json(self.base + "/v1/ankify", body, self.cfg["token"])
        self.assertEqual(result["cards"][0]["format"], "cloze-list")
        self.assertEqual(result["cards"][0]["cloze_items"], ["item1", "item2", "item3"])

    def test_ankify_simple_cards_mode(self):
        body = {"kind": "text", "mode": "simple-cards", "text": "apple", "background": "词汇释义"}
        result = post_json(self.base + "/v1/ankify", body, self.cfg["token"])
        self.assertEqual(result["cards"][0]["type"], "A4")

    def test_invalid_mode_rejected(self):
        body = {"kind": "text", "mode": "image", "text": "abc"}
        try:
            post_json(self.base + "/v1/ankify", body, self.cfg["token"])
            self.fail("should have raised")
        except urllib.error.HTTPError as exc:
            self.assertEqual(exc.code, 400)

    def test_cloze_card_validation(self):
        ankifyd.validate_card(
            {"format": "cloze-list", "cloze_items": ["a", "b"], "type": "B1"},
            "test",
        )
        with self.assertRaises(ValueError):
            ankifyd.validate_card(
                {"format": "cloze-list", "cloze_items": ["a"] * 9, "type": "B1"},
                "test",
            )

    def test_finite_list_back_converted_to_cloze_list(self):
        result = ankifyd.validate_ankify_result(
            {
                "cards": [
                    {
                        "front": "What was the motivation of the Declaration of Heidelberg?",
                        "back": "common defense, external representation, national representation, removal of inter and outer danger",
                        "type": "B1",
                        "extra": "",
                    }
                ],
                "pipeline": "single-pass",
            }
        )
        card = result["cards"][0]
        self.assertEqual(card["format"], "cloze-list")
        self.assertEqual(
            card["cloze_items"],
            [
                "common defense",
                "external representation",
                "national representation",
                "removal of inter and outer danger",
            ],
        )
        self.assertEqual(card["front"], "What was the motivation of the Declaration of Heidelberg?")

    def test_invalid_pipeline_normalized(self):
        result = ankifyd.validate_ankify_result(
            {
                "cards": [{"front": "q", "back": "a", "type": "A1"}],
                "pipeline": "TE",
            }
        )
        self.assertEqual(result["pipeline"], "single-pass")

    def test_classify_returns_types(self):
        body = {"text": "1848 年 2 月 24 日，国王路易·菲利普宣布退位。", "background": "历史"}
        result = post_json(self.base + "/v1/classify", body, self.cfg["token"])
        self.assertEqual(result["pipeline"], "two-pass")
        self.assertIn("A4", result["types"])

    def test_unauthorized(self):
        request = urllib.request.Request(
            self.base + "/health", headers={"Authorization": "Bearer wrong-token"}, method="GET"
        )
        try:
            NO_PROXY.open(request, timeout=5)
            self.fail("should have raised")
        except urllib.error.HTTPError as exc:
            self.assertEqual(exc.code, 401)


if __name__ == "__main__":
    unittest.main()
