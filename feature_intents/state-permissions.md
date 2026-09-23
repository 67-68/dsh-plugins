# state-permissions

## Project Overview

mode-gate 是 DSH 的工作流/状态门禁插件，控制各阶段 agent 可用 skill 与 bash 命令、注入 prompt 与初始命令，保证阶段目标按权限推进。

---

## 2026-09-23T06:54:56.810Z

### 用户原话

需求：
1. debug 为什么mode-gate 初始使用create 工作流，prompt 会丢掉
2. extend mode-gate 的阶段限制 set 系统，添加一个可选项：初始命令，可以用下拉列表 + 输入框来输入。这些命令会在开始的时候被送给对应阶段的agent。同时，agent 使用tool-search 搜索这些工具的时候允许进行（优先级高于禁止tool-search，比如说原本禁止tool search + 允许submit-state，那么允许使用tool-search 搜索submit state, 首先实际上匹配一下，如果找到了这个 tool就放行让真实的机制来搜索，如果没有就禁止）
3. 抽象具体每个阶段需要使用的命令，并给每个阶段创建对应的set 并填充对应命令。比如说requirement-recognition 的“不读代码”限制，既然requirement-recognition 需要submit-requirement-protocol, 那么就设置submit-requirement-protocol 为初始命令之一。你需要在research 阶段首先总结内容，比如说呈现一张表，关于不同的阶段具体依赖什么命令，然后转换。
4. 顺便搞一个“universal 注入命令”选项，添加todo-write 和submit-state，每个阶段都会注入这两个命令，不需要agent 自己搜索。

需求：
1. debug 为什么mode-gate 初始使用create 工作流，prompt 会丢掉
2. extend mode-gate 的阶段限制 set 系统，添加一个可选项：初始命令，可以用下拉列表 + 输入框来输入。这些命令会在开始的时候被送给对应阶段的agent。同时，agent 使用tool-search 搜索这些工具的时候允许进行（优先级高于禁止tool-search，比如说原本禁止tool search + 允许submit-state，那么允许使用tool-search 搜索submit state, 首先实际上匹配一下，如果找到了这个 tool就放行让真实的机制来搜索，如果没有就禁止）
3. 抽象具体每个阶段需要使用的命令，并给每个阶段创建对应的set 并填充对应命令。比如说requirement-recognition 的“不读代码”限制，既然requirement-recognition 需要submit-requirement-protocol, 那么就设置submit-requirement-protocol 为初始命令之一。你需要在research 阶段首先总结内容，比如说呈现一张表，关于不同的阶段具体依赖什么命令，然后转换。
4. 顺便搞一个“universal 注入命令”选项，添加todo-write 和submit-state，每个阶段都会注入这两个命令，不需要agent 自己搜索。

需求 5: 给初始阶段加上 初始命令: update_feature_intent / update_feature_list / submit_requirement_protocol

use submit_requirement_protocol

### Agent 理解
Create首阶段prompt丢失为bug需定位修复；阶段限制Set新增初始命令（下拉+输入，启动注入，tool-search白名单优先放行：先匹配有则放行无则禁止）与Universal注入（默认todo-write/submit-state，每阶段自动注入）；Research先抽象各阶段依赖成表再建Set填充；需求5要求立即给REQUIREMENT_RECOGNITION加上初始命令三件套以解死锁。

### 用户可见行为

Create初始prompt不再丢失；阶段限制可配初始命令与Universal命令并在启动注入；tool-search对白名单优先放行；各阶段有独立Set并填充；初始阶段默认带三初始命令。

### 功能意图

阶段权限门禁支持初始命令与全局注入及白名单优先放行

### Checklist

- [ ] 阶段权限门禁初始命令与Universal注入及tool-search白名单优先：初始命令可在阶段启动注入，tool-search搜白名单内放行、白名单外仍禁止，Universal命令每阶段自动注入
- [ ] 各阶段Set抽象与填充及Research依赖表：输出阶段x命令依赖表并为各阶段建Set填充，含REQUIREMENT_RECOGNITION初始命令三件套
- [ ] Create首阶段prompt丢失修复：复现并修复初始使用create工作流prompt丢失，初始阶段默认带三初始命令后可验证保留

---

## 2026-09-23T12:17:52.405Z

### 用户原话

universal 注入命令放到 mode-gate 设置工作流页（对每个 state 注入）；新 Create 首轮 prompt 仍缺席，每调工具就重注政策的“续投”立即下掉、只在阶段开始注入一次；阶段 Set 落为可配表并展示到设置-模式门禁-限制界面，同时自查其他有行为无 UI 的项；submit_requirement_protocol 之后 agent 要像 INIT 一样禁言等确认。

### Agent 理解

用户四条新需求：1）universal 注入命令搬到 mode-gate 设置工作流页，因为它对每个 state 都注入，应为全局配置；2）新 Create 首轮 prompt 仍缺席（projects 会话实测），且每调一个工具就全量重注政策（“续投”）来源不明、token 开销巨大，要求立即下掉——经查线上包确含之前写的每步续投代码，已删除整套续投/补投机制，回到阶段激活一次性注入；3）阶段 Set（BUILTIN_STAGE_COMMAND_SETS，12 阶段）目前只是代码内置表，要落为可配置表并展示到设置-模式门禁-限制界面，同时自查其他“有行为无 UI”的项；4）submit_requirement_protocol 之后 agent 应像 INIT 一样完全禁言等用户确认，而不是继续运行（即“截断”缺失，需新增 awaiting_user 闸门）。用户已明确：政策只在 create requirement recognition 等阶段开始时硬注入一次，步内不再补；已知代价是抑制路由下后续轮次可能再度缺席，待线上验证后定案。

### 用户可见行为

新开 Create 工作流：首轮即带阶段政策与 RR 三初始命令，之后每调工具不再重注政策；Universal 与阶段 Set 在设置页可见可改；提交需求协议后 agent 停下等用户确认，不再继续跑

### 功能意图

mode-gate 阶段政策只在阶段激活时注入一次；Universal 与阶段 Set 进设置页可配；协议提交后禁言等用户确认

### Checklist

- [ ] mode-gate 设置工作流页 Universal 全局配置：全局一份对所有 state 注入（下拉+输入），限制套件 universal 改为覆盖/继承
- [ ] 阶段 Set 可配置表 + UI 缺口自查补齐：BUILTIN_STAGE_COMMAND_SETS 落为可配表并展示到设置-模式门禁-限制界面，自查补齐其他有行为无 UI 的项
- [ ] 需求协议提交后禁言闸门：awaiting_user 期间 pre-step 硬 reject，对标 INIT 闸门
- [ ] 续投机制下线：步内全量续投/缺席补投已删除，政策只在阶段激活时注入一次（token 止血）；首轮缺席问题已知回退，待线上验证后定案
