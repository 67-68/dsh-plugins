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
- 会话初始为 `IDLE`（完成态），由 UI modal 选择工作流；点击工作流等价于 `/mode <workflowId>`
- 工作流状态下先 `declare_target`；IDLE 后端不限制，只靠 UI 遮罩
- 内置工作流：
  - `SIMPLE-ACTION`：`PRESET_ACTION -> ACTION_EXECUTE -> IDLE`
  - `CREATE`：`BASE_READ -> REQUIREMENT_RECOGNITION -> (RESEARCH -> EXECUTE -> DEBUG -> ACCUMULATION)*n -> IDLE`
- `IMPLEMENT` 已删除；CREATE 的 feature-intent checklist 会变成 staticPlan goals，全部完成才回 IDLE
- dynamicPlan 每个状态独立、状态切换时清空；loopMemory 每轮重新注入（幂等）
- `declare_target` 时同时声明本次需要的 `skills` 和 `bash` 命令；未声明的 `skill_load` / bash 命令会被拦截
- 纯只读命令（`ls`、`cat`、`head`、`tail`、`grep`、`find`、`sed -n`、`awk`、`wc`、`sort`、`uniq` 等）在所有状态放行，无需声明
- 不要花太多算力预判申请清单：需要额外 skill 或 bash 时直接调用 `dev_tool_search`（或 `request_extra`）申请
- 网页阅读禁止 `curl` / `wget`，统一用 `read_url` 系列工具
- 始终可用：`skill_search`、`switch_mode`、`dev_tool_search` / `request_extra`、`submit_state`
- feature_intent 目录禁止直接写，只能用 `update_feature_intent` 追加；一次写入三个 field：`user_words` / `understanding` / `checklist`
- project-experience（`<workspace>/project-experience/{project}/`）用 `read_project_experience` 读取、`update_project_experience` 写入；append 直接写，overwrite/diff 会走用户审批
- 插件代码在 `packages/dsh-mode-gate`；修改后运行 `install.sh` 同步。运行中的 DSH 会锁住 `profiles/node_modules`，需先退出 DSH 再同步

## 阶段性发言契约
- 干活时不要连续只调用工具；每完成一个阶段或关键结果，用 1-2 句话向用户说明「已完成什么 + 下一步做什么」
- 阶段可以按：信息收集 → 方案确认 → 逐文件修改 → 测试验证 → 文档更新 来切分
- 被 mode-gate 拦截时，把被拦截的 skill/bash 动词在回复里说清楚，然后调用 `request_extra` 申请

## 模式经验系统

- `GENERAL.md` 与 `{mode}.md` 现在只作为 persona / 经验文本注入（mode-experience 已瘦身，不再拆 skill、不再注册索引 skill）
- 项目级知识改用 project-experience：`<workspace>/project-experience/{project}/`，由 dsh-mode-gate 的 `read_project_experience` / `update_project_experience` 管理
