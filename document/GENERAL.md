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
- 新 session 默认 `READ_ONLY`；除白名单工具外，必须先 `declare_target` 才能行动
- `declare_target` 时同时声明本次需要的 `skills` 和 `bash` 命令；未声明的 `skill_load` / bash 命令会被拦截
- 不要花太多算力预判申请清单：需要额外 skill 或 bash 时直接调用 `request_extra` 申请，它会作为问题向用户申报
- 网页阅读禁止 `curl` / `wget`，统一用 `read_url` 系列工具
- 始终可用：`skill_search`（查看所有 skill）、`switch_mode`（请求切换模式）、`request_extra`（申请额外访问）
- 切换模式用 `switch_mode`，需要人工批准
- 插件代码在 `packages/dsh-mode-gate`；修改后运行 `install.sh` 同步

## 模式经验系统

- 每个模式的经验存在 `~/.dsh/DOCUMENT/{mode}.md`，会话开始自动注入该模式对应的文件
- 本文件 `GENERAL.md` 会注入到所有模式
- 查看完整文档与索引：加载 `mode-experience` skill
