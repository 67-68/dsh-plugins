# 阶段权限门禁初始命令与注入

- id: state-permissions
- title: 阶段权限门禁初始命令与注入
- module: mode-gate-overview
- status: in_progress
- commit: 
- completedAt: 

## user_visible_behavior

Create初始prompt不再丢失；阶段限制可配初始命令（下拉+输入，启动注入）与Universal命令（默认todo-write/submit-state，每阶段注入）；tool-search对白名单优先放行；各阶段有独立Set并填充，初始阶段默认带三初始命令。

## feature_intent

阶段门禁支持初始/全局命令注入与优先放行

## completion_evidence


