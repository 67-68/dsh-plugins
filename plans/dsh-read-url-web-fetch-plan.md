# dsh-read-url 先装计划：统一网页正文读取，减少 agent 解析试错

> 背景：DSH 对话中搜索/抓网页经常遇到 Google、Genius、Reddit、Medium 等被拦或解析失败；
> agent 会反复用 curl / 不同解析方法试，浪费大量注意力。
> 决策：**先只安装 `dsh-read-url`**，用插件把“抓 URL → 清洗正文 → 返回紧凑文本/Markdown”封装成一个工具。
> 暂不装 Playwright 后端、暂不装全局代理插件、暂不改搜索引擎提供方。

---

## 0. 已核实的事实（2026-09-02 实测）

| 项目 | 结果 |
|---|---|
| 本机出口 IP | `176.122.181.120`（IT7/16clouds，LA 机房，Just My Socks LA 节点） |
| 直连 / 走 `127.0.0.1:1082` 代理 | 出口 IP 相同 |
| Reddit.com / old.reddit / Reddit JSON API | 403 Blocked（IP 层拉黑，与 UA 无关） |
| Google Search 裸请求 | 200 但返回 enablejs 空壳，需 JS |
| Genius.com 直连 / 走代理 | 200，当前未发现 IP 层拦截 |
| Medium / Quora | Cloudflare “Just a moment” 类挑战 |
| Bing HTML / DuckDuckGo HTML | 200，结果可解析 |
| 官方 web_search 工具 | 可用 |

**推论**
1. 网页“解析失败”和“站点封 IP”是两件事。
2. `dsh-read-url` 解决“抓取 + 清洗 + 返回正文”的封装问题；不能改变 Reddit 的 IP 层 403。
3. Reddit 若必须作为资料源，后续应另走 Reddit OAuth / 第三方搜索服务 / 换住宅或干净出口；不在本计划范围。

---

## 1. 目标与成功标准

### 目标
- DSH agent 读 URL 时使用统一工具 `read_url` / `read_url_batch`，不再自行 curl + 正则 + 反复试解析。
- 返回内容默认是清洗后的正文/紧凑文本，控制 token 消耗。
- 保持对中文页面编码（GBK/GB2312/UTF-8/Big5）和常见反爬壳的基本处理。

### 成功标准
1. 安装后重启 `dsh web`，设置 → 插件中能看到 `dsh-read-url` 启用。
2. 对话中自然说“读 https://genius.com/xxx 并总结”会调用 `read_url`，不再看见 agent 自己 curl/抓 HTML 原始输出。
3. 对普通可直连站点（Genius、Wikipedia、GitHub 等）能返回干净正文；对 Reddit 等 IP 403 站点返回明确错误而不是让 agent 反复试。
4. `packages/dsh-read-url` 本地 fork 已就位，`profile/cordis.patch.yml` 已挂载；跑 `./install.sh` 幂等。

---

## 2. 范围（Scope）

### In
- 新增本地 fork：`~/Documents/dsh-plugins/packages/dsh-read-url/`（上游 v1.6.1 的最小修改版）。
- 在 `~/Documents/dsh-plugins/profile/cordis.patch.yml` 挂载 `dsh-read-url` 插件行。
- `plugins/requirements.txt` 不加外部声明（上游包过不了质量门）。
- 执行/记录安装与重启流程。
- 做冒烟测试：普通页、JS/SPA 页、失败页。

### Out（明确不做）
- 不装 `dsh-web-fetch-playwright`（等 read-url 不足时再加）。
- 不装 `dsh-plugin-proxy`（等确认需要全局代理时再加）。
- 不装 `dsh-web-access` / 不改搜索提供方。
- 不切换 Just My Socks 套餐、不装 Chrome/Edge、不做 Reddit 专用通道。

---

## 3. 文件改动

| 文件 | 改动 |
|---|---|
| `~/Documents/dsh-plugins/packages/dsh-read-url/` | 本地 fork：上游 v1.6.1 代码 + 去掉可选动态 import 的 package.json/代码 |
| `~/Documents/dsh-plugins/profile/cordis.patch.yml` | 挂载 `dsh-read-url` 插件行（plugin-manager managed block） |
| `~/Documents/dsh-plugins/plugins/requirements.txt` | **不新增** dsh-read-url 外部声明；仅加注释说明本地 fork 原因 |
| 运行时 `~/.dsh/profiles/web/package.json` | 由 `plugin_install` 写入 `link:` 本地包依赖 |
| 运行时 `~/.dsh/profiles/web/cordis.patch.yml` | 由 `plugin_install` 写入 managed insert row（当前已是真实文件，建议用 `./install.sh` 恢复 symlink） |

---

## 4. 实施步骤

### 4.1 实际采用的安装方式（2026-09-02）
1. 复制上游 v1.6.1 到 `packages/dsh-read-url`。
2. 最小修改：
   - `index.js`：移除 `@mozilla/readability` + `happy-dom` 的动态 import；
   - `spa.js`：移除 `playwright` 的动态 import（SPA 渲染本步不需要，后续可换 Playwright provider）。
3. 通过受保护的 `plugin_install` 以本地路径安装（会写 `link:` 依赖 + managed insert row）。
4. 仓库侧同步：
   - `profile/cordis.patch.yml` 保留 managed block；
   - 运行 `./install.sh` 恢复 symlink（当前 agent bash 沙箱不能写 `~/.dsh`，需在终端执行）。

> 注意：上游包本身会因“未声明的可选动态 import”被 DSH 质量门回滚；
> 因此不要把它重新放回 `plugins/requirements.txt` 作为外部插件安装。

### 4.3 冒烟测试清单
安装并重启 `dsh web` 后，用自然语言/直接工具测试：

| 用例 | 预期 |
|---|---|
| 读 `https://genius.com/` | 返回干净正文/站点简介，而不是原始 HTML |
| 读一篇普通 Wikipedia 文章 | 返回文章正文 + 截断提示，无导航/广告 |
| 读 `https://www.reddit.com/r/LocalLLaMA/...` | 返回明确的 403/失败原因；agent 不再反复 curl 重试 |
| 让 agent 同时读 2–3 个 URL | 使用 `read_url_batch` 或并行 `read_url`，输出紧凑对比 |

### 4.4 回滚
- 如果效果不符合预期：用 `plugin_uninstall` / UI 卸载 `dsh-read-url`，重启。
- 仓库侧：删除 `packages/dsh-read-url/` 与 `profile/cordis.patch.yml` 中的 managed block，用 git revert 即可。
- `plugins/requirements.txt` 不需要动（没有外部声明）。

---

## 5. 风险与边界

| 风险 | 缓解 |
|---|---|
| `read-url` 走普通 HTTP fetch，遇到 JS/Cloudflare 页面仍可能失败 | 这正是后续加 `dsh-web-fetch-playwright` 的触发条件，不在本步 |
| 对 Reddit/IP 403 无能为力 | 明确期望：返回失败原因即可，不做 agent 无限重试 |
| 上游包未声明可选动态 import，质量门拒绝 | 本地 fork 去掉动态 import；后续升级需同步补丁 |
| 外部插件引入额外工具会占 prompt 前缀 | `dsh-read-url` 设计为静态 schema/低上下文，且默认 6k 截断；若仍嫌多，可后续裁剪 |

---

## 6. 后续触发条件（backlog）

- 遇到 JS/SPA/Cloudflare 且 `read_url` 返回明显不足 → 评估加 `dsh-web-fetch-playwright`（Playwright/CDP + Readability → Markdown）。
- 需要 DSH 全链路走本机 JMS 代理 → 评估 `dsh-plugin-proxy`，但注意当前 JMS LA 节点出口 IP 对 Reddit 无效。
- 需要稳定使用 Reddit 作为资料源 → 另走 Reddit OAuth / Firecrawl/Exa 等服务商 / 换干净出口；不属于“网页读取插件”范畴。
- Google 仍必须且经常被拦 → 再评估搜索引擎提供方切换（Bing/DDG/API）。
