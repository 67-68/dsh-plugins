# 工作区整洁架构整理

- id: workspace-cleanup
- title: 工作区整洁架构整理
- module: dsh-plugins
- status: in_progress
- commit: 
- completedAt: 

## user_visible_behavior

整理后仓库根只剩真理源模块：plugins 仅 host-plane、packages 7 个双面包插件、presets、preset-actions、profile、document、去重后的 feature_intents、scripts、patches、docs/plans；重复快照与无关文件全部消失；.gitignore 新增防污染项；README 目录树更新；bash -n 与抽查 node --check 通过；一次性 chore 提交待推送。

## feature_intent

dsh-plugins 工作区去重去污、模块化归位。

## completion_evidence


