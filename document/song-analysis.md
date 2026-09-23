# Song Analysis 技能

<!-- 运行时 skill：随 install.sh 部署到 ~/.dsh/DOCUMENT/。设计计划见 docs/plans/song-analysis-integration-plan.md，模块意图见 feature_intents/song-analysis.md。 -->

#### [overview] Song Analysis 是什么

用 `song-analyze` CLI 对一首本地音频做：拆轨（all-in-one-infer/demucs）、结构分段、节拍、和弦（Chordino 或 librosa fallback）、旋律 MIDI（basic-pitch）、歌词获取（Genius 优先 / 本地 ASR 兜底）、歌词分段与讲解报告，并可在 Sonic Visualiser 中打开波形与标注层。

核心目录：

```text
projects/musicfree-dev/
├── music_install.sh              # 安装分析侧环境 + Vamp 插件
└── analysis/
    ├── bin/song-analyze          # CLI 入口（bash 包装）
    ├── pipeline/song_analyze.py  # CLI 实现
    ├── requirements.txt          # Python 依赖
    ├── requirements.lyrics.txt   # 可选：本地 ASR 兜底（faster-whisper）
    ├── requirements.vamp.txt     # Vamp 插件/SDK 下载清单
    ├── patches/                  # nnls-chroma boost-free 补丁
    ├── vamp/                     # Chordino / NNLS Chroma（安装产物）
    ├── output/                   # 每首歌一个子目录，内含 analysis.json 与 report.md
    └── venv/                     # Python 依赖
```

安装 / 重装：

```bash
cd ~/projects/musicfree-dev
./music_install.sh
```

#### [cli] 命令速查

```bash
# 完整分析（结构 + 特征 + 歌词 + report.md）
analysis/bin/song-analyze run <audio> --artist "艺术家" --title "歌名"

# 只获取歌词并分段（Genius 优先，失败时 ASR 兜底）
analysis/bin/song-analyze lyrics <audio> --artist "艺术家" --title "歌名"

# 用本地歌词文件，跳过网络与 ASR
analysis/bin/song-analyze run <audio> --lyrics-file lyrics.txt --no-asr

# 根据已有 analysis.json + lyrics.json 重新生成 report.md
analysis/bin/song-analyze report <output/xxx>

# 只跑结构
analysis/bin/song-analyze structure <audio>

# 只跑特征（beats/chords/melody），需要已有 structure.json
analysis/bin/song-analyze features <audio> --out-dir <output/xxx>

# 拉取 Genius 资料（有 token 用 lyricsgenius，没有 token 走网页抓取）
analysis/bin/song-analyze genius "艺术家" "歌名" --out-dir <output/xxx> [--token <GENIUS_TOKEN>]

# 用 Sonic Visualiser 打开音频 + beats.csv + chords.csv
analysis/bin/song-analyze open <audio> [--out-dir <output/xxx>]
```

环境变量：

- `GENIUS_ACCESS_TOKEN`：可选。配了走 lyricsgenius，不配也能用网页抓取，只是更容易被限流/页面改版影响。
- `SONG_ANALYZE_LLM_BASE_URL` / `SONG_ANALYZE_LLM_MODEL` / `SONG_ANALYZE_LLM_API_KEY`：可选。OpenAI 兼容接口，用于生成 report.md 的「Agent 讲解」；Ollama 可填 `http://localhost:11434/v1`。不配则写本地规则草稿。
- `SONG_ANALYZE_ASR_MODEL`：可选，Whisper 模型大小（默认 `base`）。
- `VAMP_PATH`：指向 `analysis/vamp`；CLI 启动时若该目录存在会自动注入，一般无需手动设置。
- 首次运行会自动下载模型到 `analysis/.cache`，耗时较长属正常。
- 歌词抓取需要联网；完全离线时要么启用本地 ASR，要么用 `--lyrics-file` 手动给歌词。

#### [workflow] Agent 工作流

1. 用户给一首歌（本地音频路径，或 MusicFree 里的本地歌曲）。
2. 调用 `song-analyze run` 产出 `analysis.json`、`lyrics.json` 与 `report.md`。
3. 歌词默认走 Genius；Genius 无结果且装了 `faster-whisper` 时会退回本地 ASR。
4. 没有 `[Verse]/[Chorus]` 标记时，歌词只按空行切成「段落 N」，不要谎称推断出了主歌/副歌。
5. 阅读 `analysis.json` 后，向用户解释：
   - 歌曲结构：每个段落的起止时间和 label（intro/verse/chorus/bridge/outro）。
   - 节拍：BPM、每小节位置（downbeats）。
   - 和弦：粗略和弦进行（注意 fallback 的和弦比较糊，必须提醒用户）。
   - 编曲：从 stems 推测每段出现的乐器。
6. 需要 AI 讲解时，给 `run` 或 `report` 配好 `SONG_ANALYZE_LLM_*`，`report.md` 的「Agent 讲解」会自动生成；没配则是本地规则草稿，要如实告诉用户。
7. 建议用户运行 `song-analyze open <audio>`，在 Sonic Visualiser 里对照波形、和弦、节拍层边听边看。
8. 如果结构 label 与歌词内容冲突，优先以音频听感 + 歌词文本为准，可人工修正 `report.md`。

#### [analysis-json] analysis.json 字段

- `track`：title / artist / path / duration_sec / bpm。
- `stems`：vocals / drums / bass / other 四轨的 wav 路径。
- `structure`：`[{start, end, label}]`。
- `beats`：节拍时间点数组（秒）。
- `downbeats`：重拍时间点数组（秒）。
- `chords`：`[{start, end, label}]`（有 Chordino 时较准，否则为 librosa fallback）。
- `melody_midi`：basic-pitch 生成的旋律 MIDI 路径。
- `genius`：Genius 拉取的歌词与段落（可能为空对象）。
- `lyrics`：`lyrics.json` 的内容：`source`（genius/whisper/file/none）、`provider_detail`、`lines`、`sections`、`error`。
- `lyrics_json`：`lyrics.json` 路径。
- `report_md`：讲解报告路径。

#### [musicfree] MusicFree 集成

- 全屏播放页（歌词页）右下角「歌曲解析」按钮打开面板。
- 主进程模块：`app/src/infra/songAnalysis/`，IPC 通道前缀 `@infra/song-analysis/*`。
- `runAnalysis` 仅对本地歌曲可用（需要 `musicItem.localPath`）；结果读取 `analysis/output/*/analysis.json` 与 `report.md`。
- 面板「设置」可以填 LLM 接口地址、模型、API Key 与 Genius Token，保存在 Electron `userData/song-analysis-config.json`；主进程 spawn CLI 时注入 `SONG_ANALYZE_LLM_*` / `GENIUS_ACCESS_TOKEN`。
- 改完设置后可以点「重新生成报告」只重写 `report.md`（走 `song-analyze report <out_dir>`），不必重跑拆轨/结构。
- Sonic Visualiser 不做内嵌，由主进程 spawn 子进程；面板按钮状态与子进程 `exit` 事件同步，用户手动关闭 SV 后按钮会自动回到关闭态。

#### [troubleshooting] 已知问题

- `Operation not permitted: /Users/.../.cache/torch`：不要改动 home 权限；CLI 已把 `TORCH_HOME` / `HF_HOME` / `MPLCONFIGDIR` 重定向到 `analysis/.cache`。
- Chordino 由 `music_install.sh` 安装到 `analysis/vamp`；如果没有该目录，CLI 会回退到 librosa 和弦，报告里必须说明这是 fallback。
- Sonic Annotator 找不到插件时，先确认 `analysis/vamp/nnls-chroma.dylib` 存在，再设置 `VAMP_PATH` 指向该目录。
- mp3 等非 wav/flac 音频在部分 libsndfile/torchaudio 构建下会解到一半失败（`Unspecified internal error`）。CLI 分析前会自动转码成 `<out_dir>/source.wav`（优先 ffmpeg，其次 librosa）并缓存；`analysis.json` 的 `track.path` 仍记录原始文件。建议安装 ffmpeg：`brew install ffmpeg`。
- MusicFree 里 `currentMusic` 是 `IMusicItemSlim`，不含 `localPath`；主进程会用 `musicSheet.getRawMusicItem(platform, id)` 取回完整 raw item 后再解析本地路径。
- 官方预编译包所在服务器可能连不上；`music_install.sh` 会自动改用源码 + `analysis/patches/nnls-chroma-no-boost.patch` 本机构建，不需要 Boost。
- basic-pitch 在 Python 3.9 + coremltools 下会打印 scikit-learn/torch 兼容警告，不影响 MIDI 输出。
- 在线音源没有本地音频文件，目前只支持本地歌曲；MusicFree 面板对在线歌曲会提示「仅本地歌曲支持分析」。
- Genius 抓取失败（无网络、被限流、歌曲太冷门）时不要把空歌词当成事实：`lyrics.error` 里会记录原因，报告也会写明「未获取到歌词」。
- 本地 ASR 对唱歌（颤音/拖长音/说唱/和声）错误率明显高于说话；优先用 Demucs 的 `vocals.wav`，并在报告里提醒用户校对，不要直接当真。
- 歌词时间轴尚未实现：ASR 结果自带每行 start/end，但目前只用于切块，没有把 Genius 歌词对齐到音频。
