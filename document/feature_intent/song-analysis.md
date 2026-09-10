# song-analysis 模块设计意图

## 功能

- 给一首本地音频，产出结构分段、节拍、和弦、旋律 MIDI、拆轨 stems、Genius 资料与 Markdown 报告。
- Agent 通过 `document/song-analysis.md` 注册的 skill 调用 `analysis/bin/song-analyze` CLI。
- Sonic Visualiser 用于打开音频与标注层，用户边听边看。

## 边界

- 只做本地音频，不下载在线音源。
- 结构分析以 all-in-one-infer 结果为准，人工修正写入 report.md，不回写 structure.json。
- 和弦没有 Vamp 插件时使用 librosa fallback，标记为粗略。
- REAPER 集成不在当前模块范围内（backlog）。

## 数据契约

- 每个输出目录一份 `analysis.json`，字段见 `document/song-analysis.md` 的 `analysis-json` 小节。
- `analysis.json` 是 Agent、MusicFree 面板、Sonic Visualiser 三方共用的契约。
- 除 `analysis.json` 与 `report.md` 外，其余产物均为中间文件，可重建。
