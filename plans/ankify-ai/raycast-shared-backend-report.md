# 给 Raycast 插件团队的共享后端对接说明

> 用途：让 Raycast「图片 → Markdown 卡片」插件复用 Ankify AI 的本地服务 `ankifyd`，避免另写一套提示词、分类法和 API 配置。
> 读者：实现 Raycast 插件的 agent。

## 1. 一句话结论

Raycast 插件与 Anki 插件共享的是 **`ankifyd` 本地服务**。服务统一持有 core（policy + prompts + schemas + examples）和 AI 配置（endpoint / api_key / models / 重试）。你不需要 vendor core，不需要直接调用模型 API，只需要薄薄一层 HTTP 调用 + cards → Markdown 渲染。

## 2. 服务位置

```text
~/.local/share/ankify-ai/ankifyd.py     # 服务程序（dsh-plugins/install.sh 部署）
~/.local/share/ankify-ai/core/          # 单一事实源 core
~/.config/ankify-ai/config.json         # 集中配置（port/token/api_key/models）
```

先部署：在 `dsh-plugins` 目录执行 `./install.sh`。

## 3. 协议

| 方法 | 路径 | 请求 | 响应 |
| --- | --- | --- | --- |
| GET | `/health` | - | `{ok, service_version, core_version, models, port}` |
| POST | `/v1/classify` | `{text, background?}` | `classify_result.json` |
| POST | `/v1/ankify` | `{kind:"text"|"image", text?, image_base64?, mime_type?, background?, classify?}` | `ankify_result.json` |

所有请求带 `Authorization: Bearer <token>`，token 在集中配置里。macOS 上注意绕过系统代理访问 `127.0.0.1`（Node 用 `fetch` 一般不受影响，Python 需要 `ProxyHandler({})`）。

## 4. 推荐调用流程

1. 启动时或首次使用时 `GET /health`；如果连不上，提示用户运行 `dsh-plugins/install.sh` 或手动启动 `python3 ~/.local/share/ankify-ai/ankifyd.py`。
2. 文字输入：`POST /v1/ankify`，body `{kind:"text", text, background?}`。
3. 图片输入：`POST /v1/ankify`，body `{kind:"image", image_base64, mime_type, background?}`（服务端会选 `models.vision` 并把 base64 组装成 image_url 发给上游）。
4. 两轮模式：先 `POST /v1/classify` 拿 `classify_result`，再 `POST /v1/ankify` 时把 `classify` 字段带上。
5. 把响应的 `cards` 数组本地渲染成 Markdown。

## 5. 输出契约

### 5.1 卡片对象

```json
{
  "front": "一句话问题或填空",
  "back": "最短答案",
  "type": "A1|A2|A3|A4|B1|B2|B3|B4|B5|B6|B7|B8",
  "tags": ["history"],
  "extra": "背景/助记/来源，不作考点"
}
```

### 5.2 ankify 结果

```json
{
  "cards": [ { "front": "...", "back": "...", "type": "A4", "tags": [] } ],
  "source_summary": "一句话说明材料主题",
  "pipeline": "single-pass"
}
```

## 6. Markdown 渲染约定（Obsidian-to-Anki）

Raycast 只负责把 `cards` 渲染成 Markdown。建议格式：

```md
# 材料标题

Q: 1848 年 2 月 24 日，国王路易·菲利普做了什么？
A: 宣布退位

Q: 1848 年 2 月 25 日凌晨，拉马丁在市政厅宣布了什么？
A: 法兰西第二共和国成立
```

规则：
- 每个 card 一段，`Q: ` 和 `A: ` 成对出现。
- 需要双向卡时渲染为两个 block（front/back 互换）。
- 连续 cloze 用 Obsidian-to-Anki 约定语法，不要在 core 层发明新语法。
- `extra` 渲染为答案后的括号内容，不作为考点。

## 7. 不要做

- 不要在 Raycast 插件里再维护 API key / endpoint / model 配置；统一读 `~/.config/ankify-ai/config.json`（或只暴露一个覆盖端口/路径的隐藏选项）。
- 不要 vendor core，不要自建 prompt。
- 不要在 Markdown 里发明新的卡片语法。
- 不要把 `task-audit.md` 或 Anki 的 tool-call 逻辑引入 Raycast。

## 8. 验收标准

- 同一段 1848 时间线文本，Raycast 通过 `/v1/ankify` 拿到的 cards 与 core 示例的拆分方式一致。
- 更换模型后，`/v1/ankify` 返回仍能通过服务端校验。
- Markdown 可直接被 Obsidian-to-Anki 插件识别导入。
