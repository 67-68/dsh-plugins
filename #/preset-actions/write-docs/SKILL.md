# 写文档（preset action）

<!-- mode-gate: {"description":"编写或更新简单文档，按模板套用，不需要架构决策","match":"用户要求写 README、模块说明、契约文档等机械写作任务时命中","model":"deepseek-v4-flash","provider":"deepseek-official","reasoning_effort":"low"} -->

## 匹配条件

当用户需求是「写 / 更新某个文档」且不涉及架构决策时命中。

## 执行步骤

1. 确认目标文档路径与所需内容。
2. 直接按仓库现有文档风格编写。
3. 检查标题层级与中文标点。
4. 只写文档，不要改动代码或架构。
