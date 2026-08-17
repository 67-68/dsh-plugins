# 宣传帖草稿（三版定位）

> 用法：V2EX 用「版本一」原文发帖；掘金把开头改成技术博客语气（见「版本二」差异说明）；
> GitHub Discussion 用「版本三」——它是**参与 RFC 讨论的实质评论**，不是广告贴，别把「版本一」原样丢进去。

---

## 版本一 · V2EX 主帖

**标题**：把 DeepSeek Harness 的整套配置 git 化了：一个仓库 = preset + 插件 + 经验文档，一条命令同步

DSH 生态现在很热闹，插件/marketplace 一天一更。但我一直缺一样东西：**怎么把我自己这套配置（preset + 插件 + 文档 + patch）当成一个整体来管理、复现、回滚**。

marketplace 的「浏览 + 一键装」解决的是「发现新插件」，解决不了「复现我这套环境」。于是我把它做成了 **DSH 的 dotfiles**：

一个 git 仓库就是「真理源」，`~/.dsh` 只是投影。一条 `./install.sh` 幂等同步，六类内容三种策略：

| 内容 | 策略 | 为什么 |
| --- | --- | --- |
| host 插件 / patch / 文档 | symlink | 改仓库 = 改运行时 |
| preset / 双面包包 | 真实拷贝 | symlink 会被 agent-presets 发现逻辑跳过 / Node realpath 后 peer 依赖解析失败 |
| 外部插件 | `requirements.txt` 锁版本 + pnpm 安装 | 显式、可审计、可复现 |

`requirements.txt` 里每行一个 `source@version`，升级 = 手动改版本号 + 重跑 install，绝不 `@latest` 漂移。

这个范式在 Claude Code 生态已经被验证过了（[`ai-sync`](https://github.com/berlinguyinca/ai-sync)、`dotai`、[`ai-config-cli`](https://pypi.org/project/ai-config-cli/)），但在 DSH 里还没被广泛实践——现成的「分享整套配置」工具基本都是刚生成的 1-star repo。所以我把这条路搬进了 DSH。

顺带沉淀了三个坑（每个都卡了我一阵）：preset 必须真实目录不能 symlink、双面包包必须真实拷贝不能 symlink、外部插件要锁版本别追 latest。详见仓库 README。

仓库：https://github.com/67-68/dsh-plugins （MIT，欢迎拍砖，尤其是「为什么不直接用 marketplace 一键装」这种问题）

---

## 版本二 · 掘金（差异说明）

掘金读者偏「看教程学范式」，把 V2EX 版的「发帖语气」改成「技术分享语气」，重点调整：

1. **开头换成问题驱动**：从「你怎么管理多台机器/多套 DSH 配置」切入，而不是「我又造了个轮子」。
2. **加一节「核心思想：真理源 vs 投影」**：把「仓库是唯一可编辑源、运行时是派生产物」讲透，这是 dotfiles 范式的灵魂，比列命令更有传播力。
3. **坑的部分扩成「避坑指南」小节**，每条给「症状 → 根因 → 修法」三段（README 里已有，直接搬）。
4. **结尾放「可复现的最小仓库结构」代码块**（README 的目录树），让读者能直接抄。
5. 标题候选：《DeepSeek Harness 配置管理：把你的整套 agent 环境 git 化》《DSH 的 dotfiles 范式：一个仓库管好 preset / 插件 / 经验文档》。

---

## 版本三 · GitHub Discussion（RFC #1629 的实质评论）

> RFC #1629 是「官方 plugin scaffold 提案（template repo + `pnpm create dsh-plugin`）」。
> 你要发的不是「看看我的东西」，而是补一个**提案没覆盖的空白**：scaffold 解决「怎么生成一个插件」，
> 但生态还缺「怎么把一整套配置当代码来分享」。你的仓库是那个空白的**一个实例**。措辞建议：

---

RFC 里讨论的是「怎么生成单个插件」（scaffold），我想补一个相邻的空白：**「怎么把一整套配置当代码来分享」**。

「Everything is a plugin」意味着一个人真正的 setup 是一摞层的组合（preset + bundle + patch + 经验文档），单个插件的 scaffold 解决不了「复现整摞层」的问题。

这条「配置即代码 / dotfiles」范式在 Claude Code 生态已经被验证（`ai-sync`、`dotai`、`ai-config-cli`），但在 DSH 里还没有被广泛实践——现成的「分享整套配置」工具（如 dshp）基本都是刚生成的 1-star repo，不足以作为范式参考。

我在 DSH 里做了一个最小实例（https://github.com/67-68/dsh-plugins），核心就三件事：symlink/copy/pnpm 三种同步策略的边界、preset 与双面包包为什么必须真实拷贝、外部依赖显式锁版本。

想抛给 RFC 的问题是：**官方 scaffold 是否应该顺带给出「配置仓库」的推荐目录结构（presets/ + plugins/ + packages/ + document/ + install.sh）**，让「生成一个插件」和「管理一整套配置」两个范式都能一键起步？这比只给 plugin scaffold 更能降低生态的复现成本。

---

## 附：发布前自查（已做完的 ✓）

- [x] LICENSE（MIT，2026，67_68）
- [x] README 清掉个人硬编码路径（`/Users/a67_68/...` → 泛化表达）
- [x] README 加「定位 / Why / 生态现状与定位」
- [ ] GitHub 加 `#dsh` topic + description（**需要你手动执行，命令见下**）
- [ ] commit + push（**需要你手动执行**）

> ⚠️ 版本三发出去前先自测：RFC 讨论是英文为主，上面中文建议翻成英文再发，或直接找官方 maintainer 有没有中文讨论串。
