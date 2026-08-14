# dsh-plugins

我在 DeepSeek Harness (DSH) 上自建的插件与 agent preset 仓库。这里是「真理源」；运行时位置是 `~/.dsh/`。

## 目录结构

```
dsh-plugins/
├── plugins/                  # host-plane 永久插件（*.mjs，真实 Node 模块）
│   └── mode-experience.mjs   #   按 preset 名注入 DOCUMENT/{preset}.md 到 system prompt
├── presets/                  # 自建 agent preset（每 preset 一个目录）
│   ├── architect/
│   └── g-chat/
├── profile/
│   └── cordis.patch.yml      # web profile 的 user patch 层，引用 ../plugins/*.mjs
├── install.sh                # 一键把上面内容 symlink 进 ~/.dsh
└── README.md
```

## 部署

```bash
./install.sh            # 部署到 ${DSH_HOME:-$HOME/.dsh}
./install.sh /path      # 部署到指定 DSH home
```

`install.sh` 会做三件事（全部用 symlink，改仓库 = 改运行时）：

1. `plugins/*.mjs` → `~/.dsh/profiles/web/*.mjs`
2. `profile/cordis.patch.yml` → `~/.dsh/profiles/web/cordis.patch.yml`
3. `presets/*/` → `~/.dsh/.agent-presets/*/`

**改完插件后必须重启 `dsh web` 才生效**（web 的 HMR 是关闭的）。

## 注意事项

- **不要直接 `git init` 在 `~/.dsh/` 里**：那里混着 `sessions/`、`storages/`、`.anonymous-user-id`、`node_modules/` 等敏感/无关内容。
- **不要改部署自带的 preset**：`/Users/a67_68/.npm/_npx/*/config/agent-presets/` 下的 `cordis` 等 preset 属于部署本身，升级会被覆盖。要改就 copy 一份到这里再改。
- `profile/cordis.yml` 是 profile loader 自动生成的空根，不要手动编辑，也不要入库（已 gitignore）。
- 如果 `dsh web` 在启动时重新生成了某个文件覆盖了 symlink，重跑一次 `./install.sh` 即可。

## 连远程仓库（备份 + 版本管理）

```bash
git remote add origin <你的私有仓库 URL>
git push -u origin main
```

推荐用私有仓库（GitHub / Gitea / GitLab 均可）。
