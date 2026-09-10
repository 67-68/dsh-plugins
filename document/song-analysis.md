# Song Analysis 技能

#### [overview] Song Analysis 是什么

用 `song-analyze` CLI 对一首本地音频做：拆轨（all-in-one-infer/demucs）、结构分段、节拍、和弦（Chordino 或 librosa fallback）、旋律 MIDI（basic-pitch）、Genius 资料拉取，并可在 Sonic Visualiser 中打开波形与标注层。

核心目录：

```text
musicfree-dev/
├── music_install.sh              # 安装分析侧环境 + Vamp 插件
└── analysis/
    ├── bin/song-analyze          # CLI 入口（bash 包装）
    ├── pipeline/song_analyze.py  # CLI 实现
    ├── requirements.txt          # Python 依赖
    ├── requirements.vamp.txt     # Vamp 插件/SDK 下载清单
    ├── patches/                  # nnls-chroma boost-free 补丁
    ├── vamp/                     # Chordino / NNLS Chroma（安装产物）
    ├── output/                   # 每首歌一个子目录，内含 analysis.json 与 report.md
    └── venv/                     # Python 依赖
```

安装 / 重装：

```bash
cd musicfree-dev
./music_install.sh
```

#### [cli] 命令速查

```bash
# 完整分析（结构 + 特征 + 可选 Genius）
analysis/bin/song-analyze run <audio> --artist "艺术家" --title "歌名"

# 只跑结构
analysis/bin/song-analyze structure <audio>

# 只跑特征（beats/chords/melody），需要已有 structure.json
analysis/bin/song-analyze features <audio> --out-dir <output/xxx>

# 拉取 Genius 资料
analysis/bin/song-analyze genius "艺术家" "歌名" --out-dir <output/xxx> --token <GENIUS_TOKEN>

# 用 Sonic Visualiser 打开音频 + beats.csv + chords.csv
analysis/bin/song-analyze open <audio> [--out-dir <output/xxx>]
```

环境变量：

- `GENIUS_ACCESS_TOKEN`：Genius API token，用于拉歌词与段落。
- `VAMP_PATH`：指向 `analysis/vamp`；CLI 启动时若该目录存在会自动注入，一般无需手动设置。
- 首次运行会自动下载模型到 `analysis/.cache`，耗时较长属正常。

#### [workflow] Agent 工作流

1. 用户给一首歌（本地音频路径，或 MusicFree 里的本地歌曲）。
2. 调用 `song-analyze run` 产出 `analysis.json`。
3. 如果用户需要资料讲解，拉 Genius（需要 token），把 `genius.json` 的内容作为参考资料，与 `analysis.json` 一起阅读。
4. 阅读 `analysis.json` 后，向用户解释：
   - 歌曲结构：每个段落的起止时间和 label（intro/verse/chorus/bridge/outro）。
   - 节拍：BPM、每小节位置（downbeats）。
   - 和弦：粗略和弦进行（注意 fallback 的和弦比较糊，必须提醒用户）。
   - 编曲：从 stems 推测每段出现的乐器。
5. 把讲解写入 `report.md`，并在时间轴表格里标注每个段落的听点。
6. 建议用户运行 `song-analyze open <audio>`，在 Sonic Visualiser 里对照波形、和弦、节拍层边听边看。
7. 如果结构 label 与 Genius 资料冲突，优先以音频听感 + Genius 文本为准，可人工修正 `report.md`。

#### [analysis-json] analysis.json 字段

- `track`：title / artist / path / duration_sec / bpm。
- `stems`：vocals / drums / bass / other 四轨的 wav 路径。
- `structure`：`[{start, end, label}]`。
- `beats`：节拍时间点数组（秒）。
- `downbeats`：重拍时间点数组（秒）。
- `chords`：`[{start, end, label}]`（有 Chordino 时较准，否则为 librosa fallback）。
- `melody_midi`：basic-pitch 生成的旋律 MIDI 路径。
- `genius`：Genius 拉取的歌词与段落（可能为空对象）。
- `report_md`：讲解报告路径。

#### [musicfree] MusicFree 集成

- 全屏播放页（歌词页）右下角「歌曲解析」按钮打开面板。
- 主进程模块：`app/src/infra/songAnalysis/`，IPC 通道前缀 `@infra/song-analysis/*`。
- `runAnalysis` 仅对本地歌曲可用（需要 `musicItem.localPath`）；结果读取 `analysis/output/*/analysis.json` 与 `report.md`。
- Sonic Visualiser 不做内嵌，由主进程 spawn 子进程；面板按钮状态与子进程 `exit` 事件同步，用户手动关闭 SV 后按钮会自动回到关闭态。

#### [troubleshooting] 已知问题

- `Operation not permitted: /Users/.../.cache/torch`：不要改动 home 权限；CLI 已把 `TORCH_HOME` / `HF_HOME` / `MPLCONFIGDIR` 重定向到 `analysis/.cache`。
- Chordino 由 `music_install.sh` 安装到 `analysis/vamp`；如果没有该目录，CLI 会回退到 librosa 和弦，报告里必须说明这是 fallback。
- Sonic Annotator 找不到插件时，先确认 `analysis/vamp/nnls-chroma.dylib` 存在，再设置 `VAMP_PATH` 指向该目录。
- 官方预编译包所在服务器可能连不上；`music_install.sh` 会自动改用源码 + `analysis/patches/nnls-chroma-no-boost.patch` 本机构建，不需要 Boost。
- basic-pitch 在 Python 3.9 + coremltools 下会打印 scikit-learn/torch 兼容警告，不影响 MIDI 输出。
- 在线音源没有本地音频文件，目前只支持本地歌曲；MusicFree 面板对在线歌曲会提示「仅本地歌曲支持分析」。
