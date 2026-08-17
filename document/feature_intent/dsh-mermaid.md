# mermaid 渲染 (dsh-mermaid)

让模型在回复中输出的 ```` ```mermaid ```` 代码块自动渲染成图（流程图 / UML 类图、时序图、状态图、ER 图）。

## 为什么需要

DSH 的 markdown 渲染器是一条封闭的内部管线（micromark → mdast → 自研 React 渲染器）。代码围栏统一进 `CodeBlock`（shiki 高亮），而 `mermaid` 不是已知语言，所以模型写的 mermaid 代码块被降级成纯文本源码，用户看不到图。

DSH 没有公开的「代码块渲染器」扩展点（`conversation.chat.node` 是整节点替换，不是 per-fence 注入），所以只能走「DOM 后处理」：等内部渲染器把 mermaid 块画成源码代码块后，客户端再扫描并把目标块替换成 SVG。

## 功能

- **被动渲染**：模型写 ```` ```mermaid ```` 代码块（内部首行 `flowchart` / `sequenceDiagram` / …），settle 后自动替换为 mermaid 生成的 SVG 图。
- **白名单五类**：`flowchart` / `graph`、`sequenceDiagram`、`classDiagram`、`stateDiagram` / `stateDiagram-v2`、`erDiagram`；其余 diagram（gantt / pie / mindmap / timeline 等）保持源码不渲染。
- **交互外壳**：SVG 上方「图 / 源码」切换开关 + 「复制源码」按钮，便于查看和回改 mermaid 源码。
- **错误兜底**：渲染失败 / 源码超长 / 白名单外 → 保留源码代码块，必要时显示错误提示，绝不留下半截坏图。
- **流式安全**：`[data-streaming]` 未 settle 的块不渲染，settle 后再渲染，避免流式期间反复扫描/闪烁。

## 数据源与边界

- mermaid 引擎**不进 client bundle**（DSH 客户端模块系统禁止 import 第三方裸包，会报 `missed the module table`）。它被 esbuild 打成 **IIFE 单文件静态资源** `lib/assets/mermaid.js`，由 host 面通过 `webServer` 服务注册路由 `/plugins/dsh-mermaid/assets/*` 提供，client 面动态 `<script>` 加载后读全局 `window.__MermaidAsset__`。
- 渲染在**浏览器侧**完成（mermaid 是浏览器库，依赖 DOM）。host 面只负责 serve 静态资源，不参与渲染。
- **只接管** `.md-code-block` 里的 `language-mermaid` 块；其他代码块、其他 fence 语言一概不碰，不与内置代码高亮（shiki）冲突。
- 白名单校验在 client 侧渲染前完成（提取源码首行 diagram 类型），不依赖 mermaid 的懒加载类型裁剪。
