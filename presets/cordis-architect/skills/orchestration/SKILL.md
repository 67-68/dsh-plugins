# 多 agent 编排（替代 workflow / ralph 工具）

本模式已禁用 workflow / ralph 工具，编排改用基础 subagent 手工铺：

fan-out（原 workflow）：
- 拆成 N 个自包含子任务 → 并行 subagent / subagent_fork。
- 结果回传：要求每个子代理在最终回复给结构化摘要。
- 分阶段：手工按轮次收敛，不做 pipeline()/parallel() helper。

新鲜迭代（原 ralph）：
- 用不继承上下文的 subagent（或新开会话），共享工作区当持久记忆。
- 每轮只看上一轮的有界结构化报告，不污染父对话。
