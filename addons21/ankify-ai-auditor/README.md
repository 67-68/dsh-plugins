# Ankify AI Auditor

在 Anki Browser 中清洗已有笔记：选中笔记 → 顶部工具栏“清洗” → 后台调用 DeepSeek（或 OpenAI 兼容 API）审计每条 note，给出 keep / modify / split 建议，用户确认后写回。

## 状态

当前目录包含插件骨架的非代码部分：
- `manifest.json`：Anki 插件清单。
- `config.json`：默认配置。
- `resources/ankify-ai-core/`：共享 core（policy、prompts、schemas、examples）。

Python 实现文件待编码模式补齐：`__init__.py`、`config.py`、`core_loader.py`、`note_repo.py`、`prompt_builder.py`、`api_client.py`、`validator.py`、`applier.py`、`task_manager.py`、`transaction_log.py`、`ui/task_panel.py`、`ui/edit_table.py`。

## 安装

1. 把本目录链接或复制到 Anki `addons21/ankify-ai-auditor/`。
2. 在 Anki 插件配置中填入 `api_key`。
3. 重启 Anki，打开 Browser，选中笔记，点“清洗”。

## 共享 core 版本

`resources/ankify-ai-core/VERSION` = 0.1.0，与仓库根目录 `ankify-ai-core` 同步；更新时用 `cp -R ankify-ai-core addons21/ankify-ai-auditor/resources/` 覆盖。
