# dsh-plugins

我在 DeepSeek Harness (DSH) 上自建的插件与 agent preset 仓库。这里是「真理源」；运行时位置是 `~/.dsh/`。

> **定位**：把整套 DSH 配置（preset + 插件 + 经验文档 + profile patch）当成一个 **git 仓库**来管理——可 review、可回滚、可协作，用一条 `./install.sh` 幂等同步到 `~/.dsh`。这是 DSH 的「dotfiles 范式」，不是又一个插件。

## 为什么（Why）

DSH 生态里装插件的主流方式是 marketplace「浏览 + 一键装」。这适合**发现新插件**，但不适合**复现你自己的整套配置**。本仓库解决后一个问题：

| 诉求 | marketplace 一键装 | 本仓库（dotfiles 范式） |
| --- | --- | --- |
| 发现新插件 | ✅ 强 | ❌ 不管 |
| 复现整套配置 | ❌ 手动拼 | ✅ `git clone` + `./install.sh` |
| 版本可审计 | 部分（`@latest` 漂移） | ✅ `requirements.txt` 锁版本 |
| 变更可 review / 回滚 | ❌ | ✅ git PR / revert |
| 团队共享 | 难 | ✅ 一个仓库 |

## 和 dshp 的区别

[`dshp`](https://github.com/asdf17128/dshp) 也做「分享整套 DSH 配置」，但它和本仓库是**两种不同的范式**：

| | dshp | 本仓库 |
| --- | --- | --- |
| 形态 | 把 profile 导出成一个 `.dshp` 快照文件 | git 仓库常驻，是「真理源」 |
| 同步 | `export` → 手动 `import` 快照 | `./install.sh` 幂等持续同步 |
| 外部插件 | 记录在快照里 | `requirements.txt` 显式锁版本清单 |
| 变更 | 快照间 `diff` | git 原生 PR / 历史 / revert |
| 适用 | 打包一份配置分发给别人 | 长期维护「我的/团队的」整套配置 |

一句话：**dshp 是「导出快照分发」，本仓库是「配置即代码，git 常驻 + 幂等同步」**。二者互补，不互斥。

## 目录结构

```
dsh-plugins/
├── plugins/                  # host-plane 插件 + 外部插件声明
│   ├── mode-experience.mjs   #   按 preset 名注入 DOCUMENT/{preset}.md 到 system prompt
│   └── requirements.txt      #   外部插件声明（source@version，# 注释，版本锁死）
├── packages/                 # 本地双面包插件（每包一个目录，basename = 包名）
│   └── .gitkeep
├── presets/                  # 自建 agent preset（每 preset 一个目录）
│   ├── architect/
│   └── g-chat/
├── profile/
│   └── cordis.patch.yml      # web profile 的 user patch 层，引用 ../plugins/*.mjs
├── document/                 # 经验文档（GENERAL.md 全模式 + {mode}.md 按模式）
│   ├── GENERAL.md
│   └── cordis.md
├── install.sh                # 一键把上面内容 symlink/安装 进 ~/.dsh
└── README.md
```

## 部署

```bash
./install.sh            # 部署到 ${DSH_HOME:-$HOME/.dsh}
./install.sh /path      # 部署到指定 DSH home
```

`install.sh` 会做六类同步（plugins / profile / document 用 symlink，改仓库 = 改运行时；**presets 和 packages 必须用真实目录拷贝**；外部插件用 pnpm 安装）：

1. `plugins/*.mjs` → `~/.dsh/profiles/web/*.mjs`
2. `profile/cordis.patch.yml` → `~/.dsh/profiles/web/cordis.patch.yml`
3. `presets/*/` → `~/.dsh/.agent-presets/*/`（**拷贝，不是 symlink**）
4. `document/*.md` → `~/.dsh/DOCUMENT/*.md`
5. `packages/*/` → `~/.dsh/profiles/node_modules/<包名>`（本地双面包插件 **拷贝**）
6. `plugins/requirements.txt` → `dsh plugin --profile web add`（外部插件安装，pnpm 前向器）

> 为什么 presets 不能 symlink：agent-presets 发现逻辑用 `readdir(..., { withFileTypes: true })`，
> 只认 `child.isDirectory() === true` 的目录；symlink 的 `isDirectory()` 恒为 `false`，
> 会被静默跳过 —— 所以你在仓库里能看到 preset，`dsh` 的模式选择器里却看不到。
>
> 为什么 packages 不能 symlink：Node 加载模块时会 realpath 符号链接，随后从仓库目录
> 向上解析包内部的裸 peer 依赖（如 `@deepseek-ai/dsh-typert-protocol`），而仓库没有
> `node_modules/`（已 gitignore），导致 `ERR_MODULE_NOT_FOUND`。真实拷贝让模块物理落在
> `profiles/node_modules` 下，peer 依赖自然解析。

**改完插件后必须重启 `dsh web` 才生效**（web 的 HMR 是关闭的）。

## 注意事项

- **不要直接 `git init` 在 `~/.dsh/` 里**：那里混着 `sessions/`、`storages/`、`.anonymous-user-id`、`node_modules/` 等敏感/无关内容。
- **不要改部署自带的 preset**：`dsh` 安装位置旁的 `config/agent-presets/`（通常是某次 `npx` 缓存里的 `node_modules/@deepseek-ai/dsh/config/agent-presets/`）下的 `cordis` 等 preset 属于部署本身，升级会被覆盖。要改就 copy 一份到这里再改。
- `profile/cordis.yml` 是 profile loader 自动生成的空根，不要手动编辑，也不要入库（已 gitignore）。
- `DOCUMENT/` 里的 `.mode-experience.log` 是插件运行日志，不入库（已 gitignore）。
- 如果 `dsh web` 在启动时重新生成了某个文件覆盖了 symlink，重跑一次 `./install.sh` 即可。

## 连远程仓库（备份 + 版本管理）

```bash
git remote add origin <你的私有仓库 URL>
git push -u origin main
```

推荐用私有仓库（GitHub / Gitea / GitLab 均可）。
