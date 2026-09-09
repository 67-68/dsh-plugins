# 通用经验（所有模式）
## GIT 使用契约
- **不要**对GIT 进行只读操作之外的任何操作，其他操作你把命令列出来叫我来搞。

## DSH 修改契约
- 如果要进行任何结构性修改，**首先**考虑修改本地文件，然后通过install.sh 同步。否则同步会被覆盖。

## DSH Bash 工具使用契约
- **禁止**在 dsh 的 bash 工具里用多行内联 heredoc（`python3 - <<'PY' ... PY`）跑长脚本：shell 可能停在等待 heredoc 结束符的状态，看起来像“卡住”，手动打断后只会显示 `Error: [object Object]`
- 长脚本先落盘再执行：先把脚本写到 `/tmp/xxx.py`，再 `python3 /tmp/xxx.py`
- 遇到“卡住”先判断是否根本没开始执行（例如命令里前面的 `mkdir`/`cd` 都没生效），不要先怀疑脚本算法慢

## DSH mode-gate 使用契约
- 新 session 必须先 `declare_target` 才能行动；声明后自动进入 `PRESET_ACTION` 探测阶段
- 需求循环：`PRESET_ACTION` -> `REQUIREMENT_RECOGNITION`（读 feature intent + append + 提交协议）-> `IMPLEMENT`；未完成当前目标时，目标外的工具（含 bash）会被拦截
- `declare_target` 时同时声明本次需要的 `skills` 和 `bash` 命令；未声明的 `skill_load` / bash 命令会被拦截
- 不要花太多算力预判申请清单：需要额外 skill 或 bash 时直接调用 `dev_tool_search`（或 `request_extra`）申请，它会作为问题向用户申报
- 网页阅读禁止 `curl` / `wget`，统一用 `read_url` 系列工具
- 始终可用：`skill_search`（查看所有 skill）、`switch_mode`（请求切换阶段）、`dev_tool_search` / `request_extra`（申请额外访问）
- feature_intent 目录禁止直接写，只能用 `update_feature_intent` 追加
- 插件代码在 `packages/dsh-mode-gate`；修改后运行 `install.sh` 同步

## 阶段性发言契约
- 干活时不要连续只调用工具；每完成一个阶段或关键结果，用 1-2 句话向用户说明「已完成什么 + 下一步做什么」
- 阶段可以按：信息收集 → 方案确认 → 逐文件修改 → 测试验证 → 文档更新 来切分
- 被 mode-gate 拦截时，把被拦截的 skill/bash 动词在回复里说清楚，然后调用 `request_extra` 申请

## 模式经验系统

- 每个模式的经验存在 `~/.dsh/DOCUMENT/{mode}.md`，会话开始自动注入该模式对应的文件
- 本文件 `GENERAL.md` 会注入到所有模式
- 查看完整文档与索引：加载 `mode-experience` skill
