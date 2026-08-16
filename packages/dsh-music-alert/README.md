# dsh-music-alert

DSH 任务完成播放提示音 + 按需音乐播放插件。

长任务完成时自动播放一段提示音；Agent 也可通过 `play_music` 工具主动播放。Web 设置页提供「音乐提醒」面板：上传 / 试听 / 设为完成音 / 删除 / 启停开关。

---

## Overview

- **解决什么问题**：DSH 长任务（构建、批量生成、耗时等待）完成后，用户往往不在屏幕前。本插件在每轮 turn 结束（`agent/status` → `idle`）时自动播放 `~/.dsh/music/` 下的默认完成音，把用户叫回来看结果。
- **适合谁**：本地运行 DSH（macOS / Linux）且希望有声音提醒的用户。
- **能力**：
  - Host 半（`lib/index.js`）：自动完成播报 + `play_music` 工具 + `play-music` skill 引导 + `musicAlert` Remote 服务（音乐库读写）。
  - Web 半（`lib/client.js`）：设置页「音乐提醒」tab（上传 / 列表 / 播放 / 设为完成音 / 删除 / 启用开关），通过 `dsh.client` 双面声明加载。

## Compatibility

- 面向 DeepSeek Harness（DSH）Web profile。
- peer 依赖：`@deepseek-ai/*` `^0.1.0-rc.6`、`@deepseek-ai/cordis ^4.0.1`、`react ^18.2.0`。
- 平台：Host 半调用系统命令行播放器（macOS `afplay`；Linux `aplay` / `paplay` / `ffplay` / `mpg123`）；Web 半渲染于 Web profile 设置页。
- 最后验证：本地 `dsh web`（当前 mainline）实测通过（自动播报 + 工具 + Web tab），验证日期见仓库最近提交。

## Install / Uninstall

安装（npm，发布后）：

```bash
npx @deepseek-ai/dsh plugin add dsh-music-alert
```

或从 git 安装（插件市场走的也是 git 克隆 + 质量门禁）：

```bash
npx @deepseek-ai/dsh plugin add github:67-68/dsh-music-alert
```

> 若 `web` 不是默认 profile，需追加 `--profile web`。

升级（重装到新版本）：

```bash
npx @deepseek-ai/dsh plugin add dsh-music-alert@latest
```

卸载：

```bash
npx @deepseek-ai/dsh plugin remove dsh-music-alert
```

卸载只会移除依赖与挂载行；音乐文件保留在 `~/.dsh/music/`，不会被删除。

## Quick start

1. 安装后重启 `dsh web`。
2. 放一首音频到 `~/.dsh/music/complete.mp3`（默认完成音），或放任意受支持音频后在设置页「音乐提醒」tab 设为完成音。
3. 完成一个任务 → 自动播放完成音；Agent 也可主动调用 `play_music` 工具。

Agent 工具调用示例：

```
play_music                    # 播放默认完成音
play_music file=ding.wav      # 播放指定文件
```

## Configuration

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `musicDir` | `~/.dsh/music` | 音乐库目录，支持前导 `~` 展开 |
| `enabled` | `true` | 是否启用自动完成播报 |
| `defaultFile` | `complete.mp3` | 默认完成音文件名（可被设置页 / `.state.json` 覆盖） |
| `player` | 自动探测 | 播放器命令；未指定时按 `afplay → ffplay → mpg123 → aplay → paplay` 顺序探测 |
| `minGapSeconds` | `0` | 两次自动播报之间的最小间隔（秒） |

运行状态持久化于 `~/.dsh/music/.state.json`（`enabled` / `defaultFile`）。

支持音频扩展名：`.mp3` `.wav` `.m4a` `.ogg` `.flac` `.aac` `.aiff` `.caf`。

## Permissions & data

- **文件**：仅读写 `~/.dsh/music/`（音乐文件 + `.state.json`）。文件名经 `basename` + 扩展名白名单 + `..` 路径穿越校验，不会触碰目录之外的路径。
- **网络**：无。本插件不发任何网络请求。
- **进程**：通过 `spawn` 调用本地命令行播放器（detached / unref），不读取任何凭据或环境密钥。
- **上传**：设置页上传的文件以 base64 写入音乐库目录，仅本地保存。

## Troubleshooting

- **不播报**：确认 `~/.dsh/music/` 下存在默认完成音（默认 `complete.mp3`），且设置页「启用完成播报」已开启。
- **macOS 无声音**：确认 `afplay` 可用（`which afplay`）。
- **Linux 无声音**：安装 `ffplay` / `mpg123` / `aplay` / `paplay` 之一。
- **当前播放器**：设置页「音乐提醒」tab 顶部会显示探测到的 `player`。
- **日志**：Host 侧失败会打印 `[dsh-music-alert] ...` 到 DSH 进程输出。

## Development

- **结构**：
  - `lib/index.js` — Host 半：默认导出 Cordis 插件，注册 `play_music` 工具、`play-music` skill、`musicAlert` Remote 服务，并监听 `agent/status` 自动播报。
  - `lib/client.js` — Web 半：`dsh.client` 双面，手写 Typert Remote face，渲染设置页「音乐提醒」tab。
- **发布前校验**：`npm pack --dry-run` 检查产物；`keywords` 必须含 `dsh-plugin`，入口文件 `export default` 一个 Cordis 插件。
- **贡献**：欢迎 issue / PR。

## License & security

- 许可证：MIT（见 [LICENSE](./LICENSE)）。
- 安全问题：请私下通过 GitHub issue 或仓库维护者邮箱报告，勿公开披露。
