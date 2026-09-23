# 安装插件（preset action）

<!-- mode-gate: {"description":"安装一个指定的 DSH 插件或 npm 包，不需要架构思考，按步骤执行即可","match":"用户要求安装某个插件、npm 包或 dsh plugin add 时命中","model":"deepseek-v4-flash","provider":"deepseek-official","reasoning_effort":"low"} -->

## 匹配条件

当用户需求是「安装某个插件 / 包」时命中。

## 执行步骤

1. 确认要安装的插件名或来源。
2. 按仓库约定修改 `dsh-plugins/plugins/requirements.txt`（外部插件）或 `packages/`（本地插件）。
3. 运行 `./install.sh` 同步。
4. 按需重启 `dsh web` 并验证安装结果。
5. 只做安装，不要顺手重构或优化其他模块。
