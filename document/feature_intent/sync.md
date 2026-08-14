# 同步模块 (sync)

把 dsh-plugins 仓库（真理源）同步到 `~/.dsh`（生产运行时）的模块，入口是 `install.sh`。

## 功能

同步四类内容，方式因运行时读取策略而不同：

| 内容 | 源 → 目标 | 方式 | 生效时机 |
| --- | --- | --- | --- |
| 插件 | `plugins/*.mjs` → `profiles/web/*.mjs` | symlink | 重启 `dsh web` |
| 补丁 | `profile/cordis.patch.yml` → `profiles/web/cordis.patch.yml` | symlink | 重启 `dsh web` |
| 预设 | `presets/*/` → `.agent-presets/*/` | **copy（真实目录）** | **立即**（刷新浏览器） |
| 文档 | `document/*.md` → `DOCUMENT/*.md` | symlink | 重启 `dsh web` |

## 设计意图

- 仓库是真理源、`~/.dsh` 是投影：所有可编辑内容留在仓库里，可 git 管理。
- 能用 symlink 就用 symlink：plugins / profile / document 三类的加载路径会跟随 symlink，直接链接即可「改仓库即改运行时」。
- preset 例外，必须 copy：agent-presets 发现只认真实目录（见下），所以它牺牲「实时编辑」换取「能被发现」。

## 生效时机

`install.sh` 本身是一次性写文件的脚本，不被运行时「激发」。真正决定「何时被运行时捡起」的是运行时对每类内容的读取策略：

- preset 发现每次 `list()` 都重读磁盘（`dsh-agent-presets` 的 discovery 未做缓存），copy 之后下一次 `list()` 就能看到，刷新浏览器即可，无需重启。
- plugins / profile / document 在 `dsh web` 启动时读取一次（web 的 HMR 关闭；mode-experience 也在启动时把文档读进内存），改了之后要重启 `dsh web` 才生效。

## 约束与坑

- preset 目录必须是真实目录：发现用 `readdir(..., { withFileTypes: true })`，只收 `child.isDirectory() === true` 的条目；symlink 的 `isDirectory()` 恒为 `false`，会被静默跳过——表现是「仓库里有 preset，模式选择器里却没有」。
- preset 每次 install 都是 `rm -rf` + `cp -R` 覆盖，所以改完 `presets/` 要重跑 `./install.sh` 才会同步到运行时。
- `document/` 里非 `GENERAL` 的 `.md` 会被 mode-experience 当作「按 preset 名注入的经验文件」缓存（只有 preset id 恰好等于文件名时才注入）；本文件 `sync.md` 只作模块文档存在，不会被注入。
