# dsh-plugins

我在 DeepSeek Harness (DSH) 上自建的插件与 agent preset 仓库。这里是「真理源」；运行时位置是 `~/.dsh/`。

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

`install.sh` 会做六类同步（plugins / profile / packages / document 用 symlink，改仓库 = 改运行时；**presets 必须用真实目录拷贝**；外部插件用 pnpm 安装）：

1. `plugins/*.mjs` → `~/.dsh/profiles/web/*.mjs`
2. `profile/cordis.patch.yml` → `~/.dsh/profiles/web/cordis.patch.yml`
3. `presets/*/` → `~/.dsh/.agent-presets/*/`（**拷贝，不是 symlink**）
4. `document/*.md` → `~/.dsh/DOCUMENT/*.md`
5. `packages/*/` → `~/.dsh/profiles/node_modules/<包名>`（本地双面包插件 link）
6. `plugins/requirements.txt` → `dsh plugin --profile web add`（外部插件安装，pnpm 前向器）

> 为什么 presets 不能 symlink：agent-presets 发现逻辑用 `readdir(..., { withFileTypes: true })`，
> 只认 `child.isDirectory() === true` 的目录；symlink 的 `isDirectory()` 恒为 `false`，
> 会被静默跳过 —— 所以你在仓库里能看到 preset，`dsh` 的模式选择器里却看不到。

**改完插件后必须重启 `dsh web` 才生效**（web 的 HMR 是关闭的）。

## 注意事项

- **不要直接 `git init` 在 `~/.dsh/` 里**：那里混着 `sessions/`、`storages/`、`.anonymous-user-id`、`node_modules/` 等敏感/无关内容。
- **不要改部署自带的 preset**：`/Users/a67_68/.npm/_npx/*/config/agent-presets/` 下的 `cordis` 等 preset 属于部署本身，升级会被覆盖。要改就 copy 一份到这里再改。
- `profile/cordis.yml` 是 profile loader 自动生成的空根，不要手动编辑，也不要入库（已 gitignore）。
- `DOCUMENT/` 里的 `.mode-experience.log` 是插件运行日志，不入库（已 gitignore）。
- 如果 `dsh web` 在启动时重新生成了某个文件覆盖了 symlink，重跑一次 `./install.sh` 即可。

## 连远程仓库（备份 + 版本管理）

```bash
git remote add origin <你的私有仓库 URL>
git push -u origin main
```

推荐用私有仓库（GitHub / Gitea / GitLab 均可）。
