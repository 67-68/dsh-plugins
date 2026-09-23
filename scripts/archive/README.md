# scripts/archive

已执行过的一次性运维脚本，保留备查，不再参与日常流水线：

- `clean-v0-sessions.mjs` — 清洗 DSH 升级后无法迁移的 v0 历史 session。
- `fix-live-two.mjs` — 清洗含 message-edit/version 事件的 live 会话。
- `quarantine-archived-sessions.mjs` — 把已归档 session 移出扫描目录。
- `strip-origin-only.mjs` — 只删 permission/preset 事件 data 里的 origin 字段。

日常只用 `scripts/` 顶层：`build-mermaid.mjs`（构建）与
`verify-architecture.sh`（架构护栏）。
