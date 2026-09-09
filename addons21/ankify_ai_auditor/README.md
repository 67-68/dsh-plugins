# Ankify AI Auditor

在 Anki Browser 中清洗已有笔记：选中笔记 -> 顶部工具栏“清洗” -> 插件调用本地 `ankifyd` 服务 -> `ankifyd` 调用 OpenAI 兼容 API 审计每条 note，给出 keep / modify / split 建议；任务窗口可动态编辑新卡片/修改笔记，并经用户确认后写回。

本插件是**薄壳 + UI**：不持有 core、不直接调用模型 API、不保存 API key。所有 AI 相关逻辑由 `ankifyd` 本地服务承载。

## 功能

- Browser 顶部工具栏“清洗”按钮（不可用时自动退化为 Tools 菜单）。
- 后台分批调用 ankifyd；任务窗口可关闭，任务继续运行。
- 工具栏“清洗任务 N”入口，显示进度。
- 任务窗口：进度条 + 统计（建议保留/修改/拆解/失败，已应用修改/新建笔记/新建卡片）。
- 表格内可直接编辑 Front / Back / 类型 / 标签，像 Anki 内置列表一样。
- 写回策略：modify 默认保留调度；split 新建 note，原 note suspend 并打 `ankify-ai::split-source` 标签。
- 交易日志：`logs/transactions-*.jsonl`，可人工回滚。

## 安装

1. 先部署共享服务与配置：在 `dsh-plugins` 目录运行 `./install.sh`（会复制 `ankifyd/ankifyd.py` 与 `ankify-ai-core/` 到 `~/.local/share/ankify-ai/`）。
2. 把本目录 `addons21/ankify_ai_auditor/` 复制或链接到 Anki 的 `addons21/` 目录。
3. 配置 API key：编辑 `~/.config/ankify-ai/config.json` 里的 `api_key`；或保留空值并确保环境变量 `DEEPSEEK_API_KEY` / `OPENAI_API_KEY` 可用。
4. 重启 Anki，打开 Browser，选中若干笔记，点“清洗”。

## 目录结构

- `__init__.py`：Browser 入口与工具栏动作。
- `task_manager.py`：后台任务、批次、统计、应用动作。
- `ankifyd_client.py`：与本地 ankifyd 服务通信（自动拉起、健康检查、HTTP 调用）。
- `note_repo.py`：Anki note 抽取与写回。
- `config.py` / `config.json`：仅 Anki 插件自身配置（batch_size、dry_run、标签等）。
- `ui/task_panel.py` / `ui/edit_table.py`：任务窗口与可编辑表格。
- `transaction_log.py`：交易日志。

## 配置边界

| 配置 | 位置 |
| --- | --- |
| api_endpoint / api_key / models / port / token / 重试超时 | `~/.config/ankify-ai/config.json`（ankifyd 拥有） |
| batch_size / dry_run / source_tag / locked_tag / exclude_decks | Anki 插件配置（本插件拥有） |

`ankifyd` 服务端自动加载 `~/.local/share/ankify-ai/core/` 下的 policy / prompts / schemas / examples，本插件不再 vendor core。
