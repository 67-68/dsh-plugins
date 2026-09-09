# ankifyd 本地服务计划（服务版底座）

## 1. 目标

把 Ankify AI 的 AI 相关逻辑收进一个本地服务 `ankifyd`：

- 唯一持有 `ankify-ai-core`（policy / prompts / schemas / examples）。
- 唯一持有 OpenAI 兼容 API 配置（endpoint / api_key / models / 重试超时）。
- 对外提供 `classify` / `ankify` / `audit` 三个能力。

消费端只做薄壳：
- Anki 插件：抽 note -> 调 `/v1/audit` -> UI 审阅 -> 写回。
- Raycast 插件（未来）：文字/图片 -> 调 `/v1/classify` 或 `/v1/ankify` -> 本地渲染 Markdown。

## 2. 部署与配置

```text
~/.local/share/ankify-ai/
  ankifyd.py
  core/                 # 来自 dsh-plugins/ankify-ai-core
  logs/ankifyd.log

~/.config/ankify-ai/config.json
```

`dsh-plugins/install.sh` 负责复制 `ankifyd.py` 与 `ankify-ai-core/` 到统一目录；集中配置不存在时由客户端或服务端首次运行生成。

集中配置字段：

- `host` / `port` / `token`：本地服务监听与鉴权。
- `api_endpoint` / `api_key` / `api_key_file`：OpenAI 兼容 API。
- `models.text` / `models.vision` / `models.audit`：三类任务的模型。
- `temperature` / `timeout_seconds` / `max_retries`：调用策略。
- `idle_timeout_seconds`：预留的闲置退出（当前 0 表示不自动退出）。

## 3. 协议

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/health` | - | `{ok, service, service_version, core_version, models, port}` |
| POST | `/v1/classify` | `{text, background?}` | `classify_result.json` |
| POST | `/v1/ankify` | `{kind:"text"|"image", text?, image_base64?, mime_type?, background?, classify?}` | `ankify_result.json` |
| POST | `/v1/audit` | `{notes:[NotePayload]}` | `{actions:[AuditAction], keep_count}` |

所有请求带 `Authorization: Bearer <token>`，`/health` 也要求。

## 4. 服务端实现要点

- Python 3 标准库：`http.server.ThreadingHTTPServer` + `urllib.request`，零第三方依赖。
- 系统 prompt = `system-core.md` + `policy.md` + 对应 task 文件。
- `classify` / `ankify` 使用 `response_format={"type":"json_object"}`，解析时容忍 markdown code fence，之后做 schema 校验。
- `audit` 使用 `tools=audit_tools.json`，解析 tool calls 并校验字段名、类型枚举、new_notes 数量。
- 本机 mock 端点（127.0.0.1/localhost）自动绕开 macOS 系统代理，方便测试。
- 错误返回统一 JSON：`{"error":{"code":"...","message":"..."}}`。

## 5. Anki 插件改造

- 删除 `api_client.py` / `prompt_builder.py` / `core_loader.py` / `validator.py` 与 `resources/ankify-ai-core/`。
- 新增 `ankifyd_client.py`：读取集中配置、未连通时拉起 daemon、健康检查、调用 `/v1/audit`。
- `task_manager._worker` 改为调用 `ankifyd_client.audit()`。
- 插件自身配置只保留 `batch_size` / `dry_run` / `reset_on_key_change` / `source_tag` / `locked_tag` / `exclude_decks`。

## 6. Raycast 插件（未来）

- 删除自有 prompt / key / api 调用，改为调用 `/v1/classify` 与 `/v1/ankify`。
- 只保留剪贴板读取、文件选择、cards -> Markdown 渲染、写入 Obsidian。
- `ankify` 返回的是 JSON cards，不返回 Markdown。

## 7. 测试

- `dsh-plugins/ankifyd/tests/test_ankifyd.py`：mock OpenAI 兼容服务，端到端覆盖 health / classify / ankify / audit / 鉴权。
- 真实 DeepSeek 冒烟：`ankify` 与 `audit` 各跑一次 1848 时间线样例，通过 schema 校验。
