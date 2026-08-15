# 同步模块 (sync)

把 dsh-plugins 仓库（真理源）同步到 `~/.dsh`（生产运行时）的模块，入口是 `install.sh`。

## 功能

按「真理源在哪」分两类同步，方式不同：

| 内容 | 源 → 目标 | 方式 | 生效时机 |
| --- | --- | --- | --- |
| 纯 host 插件 | `plugins/*.mjs` → `profiles/web/*.mjs` | symlink | 重启 `dsh web` |
| 双面包插件 | `packages/*/` → `profiles/node_modules/<name>` | symlink | 重启 `dsh web` |
| 补丁 | `profile/cordis.patch.yml` → `profiles/web/cordis.patch.yml` | symlink | 重启 `dsh web` |
| 预设 | `presets/*/` → `.agent-presets/*/` | **copy（真实目录）** | **立即**（刷新浏览器） |
| 文档 | `document/*.md` → `DOCUMENT/*.md` | symlink | 重启 `dsh web` |
| 外部插件 | `plugins/requirements.txt` → `dsh plugin add` | **安装（pnpm）** | 重启 `dsh web` |

## 设计意图

- 仓库是真理源、`~/.dsh` 是投影：所有可编辑内容留在仓库里，可 git 管理。
- **自己写的**（plugins / packages / presets / document）用 symlink 或 copy，真理源在仓库，「改仓库即改运行时」。
- **外部第三方**（requirements.txt 声明的）用 `dsh plugin add`（= pnpm）安装，真理源在 npm / github，仓库里只声明「装哪个、锁什么版本」，不维护外部源码。
- 能用 symlink 就用 symlink：plugins / packages / profile / document 的加载路径会跟随 symlink。
- preset 例外，必须 copy：agent-presets 发现只认真实目录（见下）。

## 外部插件（requirements.txt）

- 格式：每行一个 `source@version`，`#` 开头为注释；版本**锁死**（如 `dsh-web-plugin-manager@0.3.5`），不用 `@latest`。
- `install.sh` 逐行 `dsh plugin add`；pnpm 对「specifier 未变且已装」天然 no-op，所以重复跑是幂等的。
- 升级 = 手动改版本号 + 重跑 `./install.sh`（显式、可控，不用脚本追 latest）。
- 已知权衡：裸 `dsh plugin add` 会绕过 dsh-web-plugin-manager 的质量门；外部依赖多到需要质量门时，install.sh 应改用 `dshpm install`（阶段 2 升级）。

## 生效时机

`install.sh` 本身是一次性写文件的脚本，不被运行时「激发」。真正决定「何时被运行时捡起」的是运行时对每类内容的读取策略：

- preset 发现每次 `list()` 都重读磁盘，copy 之后下一次 `list()` 就能看到，刷新浏览器即可，无需重启。
- plugins / packages / profile / document 在 `dsh web` 启动时读取一次（web 的 HMR 关闭；mode-experience 也在启动时把文档读进内存），改了之后要重启 `dsh web` 才生效。
- 外部插件通过 pnpm 写进 `profiles/web/package.json` dependencies 并装进 node_modules，重启 `dsh web` 后由 profile 组装生效。

## 约束与坑

- preset 目录必须是真实目录：发现用 `readdir(..., { withFileTypes: true })`，只收 `child.isDirectory() === true` 的条目；symlink 的 `isDirectory()` 恒为 `false`，会被静默跳过。
- preset 每次 install 都是 `rm -rf` + `cp -R` 覆盖，所以改完 `presets/` 要重跑 `./install.sh`。
- `packages/` 的双面包插件要能被 `dsh-client-modules` 解析到（hoisted 到 `profiles/node_modules` 而非 `profiles/web/node_modules`），link 路径以实施时 `node --check` 验证为准。
- `document/` 里非 `GENERAL` 的 `.md` 会被 mode-experience 当作「按 preset 名注入的经验文件」缓存；`feature_intent/*.md` 只作模块文档，不会被注入。
