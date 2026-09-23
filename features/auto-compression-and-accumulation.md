# auto-compression-and-accumulation

- id: auto-compression-and-accumulation
- title: auto-compression-and-accumulation
- module: mode-gate
- status: in_progress
- commit: 
- completedAt: 

## user_visible_behavior

用户在工作流中推进阶段时：可在一个集中设置页配置自动压缩的触发与强度；系统在上下文达到阈值时自动完成压缩，无需手动干预；阶段产出的关键结论会被累积到 overview 链中，后续阶段可直接读取复用；当处于不允许压缩/累积的阶段时，相关动作会被门禁拦截并给出明确反馈。

## feature_intent

mode-gate 工作流的上下文自动压缩与阶段成果累积，并受阶段门禁约束。

## completion_evidence


