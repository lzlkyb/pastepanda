# PastePanda 流程图支持 · 完整规划（P0 渲染 / P1 生成 / P2 交互编辑）

> 本文合并原「流程图支持-规划」与本次新增的 P2 交互编辑器规划，作为单一可信源。
> 北极星（云端大模型优先版）：个人记忆 + 环境智能 + 可托付执行。流程图是「可托付执行」在结构化表达上的延伸。

---

## 0. 需求分三档（先定义再规划，避免高估工作量）

剪贴板工具讲「流程图」有 3 种完全不同的含义，混在一起会严重高估工作量：

| 档位 | 含义 | 频率 | 是否本次范围 |
|---|---|---|---|
| **A 消费/渲染（P0）** | 从 GitHub/文档/AI 对话复制 ` ```mermaid ` 代码，PastePanda 直接渲染成图而非原始文本 | 高频 | ✅ |
| **B AI 生成（P1）** | 选中一段文字/日志 → 一键生成流程图，云端大模型产出 mermaid | 中频 | ✅ |
| **C 交互编辑（P2）** | 内置可拖拽的流程图编辑器，增删节点、连线、改样式、自动布局 | 低频（但用户已确认要做） | ✅ 本规划重点 |

三档共用同一条 **mermaid 文本协议**做往返：复制/生成得到 mermaid 文本，编辑时解析成图，保存/导出再序列化回 mermaid，形成闭环。

---

## 1. P0 渲染（已规划，简述）

- **目标**：` ```mermaid ` 围栏代码块在卡片里渲染成可视图，而非显示源码。
- **接入点**：前端已有 `src/components/MarkdownRenderer.tsx`（`marked` + `DOMPurify` + 自定义 code 渲染器）。当前 `mermaid` 被当普通代码块显示原始文本——在 code renderer 里加 `if (lang === 'mermaid')` 分支即可，**零 DB schema 改动**（mermaid 作为 markdown 围栏文本存储）。
- **安全红线**：`mermaid.initialize({ securityLevel: 'strict' })` 防 XSS；非法语法回退为代码块。
- **主题**：6 套主题（ocean/ocean-dark/midnight/forest/blossom/dawn）联动 mermaid 主题变量。
- **工作量**：3~4 人日。
- **依赖**：`mermaid`（npm 本地打包，禁用 CDN，约 1.2MB，契合"内容不出本机"隐私底线）。

---

## 2. P1 生成（已规划，简述）

- **目标**：选中条目/文字 → 「生成流程图」动作 → 云端模型产出 mermaid → 渲染（复用 P0）。
- **接入点**：`src-tauri/src/ai/actions.rs` 已有 content_types 动作体系，新增 `generate_flowchart` 动作；走便宜模型（路由策略 X）+ 脱敏前置（pasteGuard）。
- **工作流**：选中文本 → `ai_run` → 模型返回 ` ```mermaid ` 文本 → 落库为 markdown 条目（带 mermaid 围栏）→ P0 渲染。
- **工作量**：3~4 人日。

---

## 3. P2 交互编辑器（本规划重点）

### 3.1 目标与范围

**做什么（MVP）**
- 新建 / 打开一个流程图条目，在画布上**拖拽节点、拉连线、改文字、换形状、自动布局**。
- 从任意 P0/P1 的 mermaid 一键「打开为可编辑流程图」（消费侧 → 创作侧闭环）。
- 编辑后保存回历史；复制时可选「复制为 mermaid 文本」「复制为 PNG/SVG 图片」。
- 与 P0 共用渲染能力：只读态用 mermaid SVG，编辑态用 React Flow canvas。

**不做什么（MVP 边界，避免范围蔓延）**
- 不做实时多人协作、版本树、无限白板。
- 不追求全 UML 套件；先支持 **flowchart（TD/LR）+ stateDiagram** 子集，形状覆盖：矩形/圆角/菱形/圆柱(库)/平行四边形/六边形。
- 不引入云端绘图服务，全部本地。

### 3.2 技术选型（2026 核实）

| 关注点 | 选型 | 依据 |
|---|---|---|
| 编辑器内核 | **@xyflow/react v12**（React Flow 12，MIT） | 事实标准节点编辑器；v12 为命名导出 `import { ReactFlow } from '@xyflow/react'`，须 `import '@xyflow/react/dist/style.css'`，`nodeTypes/edgeTypes` 必须在组件外声明以防重渲染 |
| 自动布局 | **@dagrejs/dagre**（~40KB 同步，默认）+ **elkjs**（~1.5MB，异步，复杂层级/嵌套子图） | dagre 体积小、同步、足够 90% 流程图；elk 覆盖复杂布局。**已确认两者都纳入，elkjs 用动态 import，不进主包**（仅用户触发复杂布局时按需加载） |
| 撤销/重做 | **zundo**（zustand temporal middleware）或 React Flow 自带快照 | 编辑器必备，避免脏实现 |
| mermaid → 图 | **@vrun-design/openflowkit-core** 的 `parseMermaid(dsl)` → React Flow 兼容 nodes/edges（支持 flowchart/stateDiagram、各形状、subgraph、边标签、箭头类型）；控制不住时退回 mermaid 官方 `@mermaid-js/parser` 自写 transform | 已有成熟 parser，覆盖常见语法；自研正则解析脆弱（Codelit 实践经验：5 阶段 pipeline 仍难覆盖全部） |
| 图 → mermaid | **自研 serializer**（nodes/edges/direction → mermaid DSL） | store 是 source of truth，单向生成可靠；无需依赖逆向库 |
| 导出图片 | `html-to-image` 的 `toPng`/`toSvg`（React Flow 官方示例方案） | 生态成熟 |
| 隐私 | 全部 npm 本地打包，**零 CDN** | 红线 |

> React Flow 12 关键约束（来自官方 skill 经验）：父容器必须显式设置宽高；自定义节点内交互元素加 `nodrag`/`nowheel`/`nopan`；绝不直接 mutate `nodes/edges` 数组，用 `applyNodeChanges`/`applyEdgeChanges`/`addEdge`。

### 3.3 数据模型（关键架构决策）

新增条目类型 **`item_type = "diagram"`**，payload 为 JSON，复用现有 history 表（text/json 双列，**DB schema 无需改动**，参照 `insert_markdown_history` 加一个 `insert_diagram_history` 命令即可）。

```json
{
  "schema": "pp.diagram.v1",
  "direction": "TD",                       // 或 LR
  "nodes": [
    { "id": "n1", "type": "ppNode", "position": { "x": 80, "y": 40 },
      "data": { "label": "开始", "shape": "rounded", "color": "emerald" } }
  ],
  "edges": [
    { "id": "e1", "source": "n1", "target": "n2", "label": "是", "type": "smoothstep" }
  ],
  "mermaid": "flowchart TD\n  n1(开始) --> n2{判断}",  // 规范化文本副本：供复制/导出/搜索/P0 回退
  "theme": "ocean"
}
```

- **真值与派生**：`nodes/edges` 为可编辑真值；`mermaid` 字段由 serializer 派生并同步写回（搜索需要它做 FTS5 源，故存副本而非仅导出时生成）。
- **与 P0 关系**：P0 条目是纯 markdown 文本（含 mermaid 围栏）；P2 条目是 `diagram` 类型。两者通过 `mermaid` 文本互转——P0 卡片上加「在编辑器中打开」即 `parseMermaid(text)` → 打开编辑器；编辑保存后生成 `diagram` 条目。

### 3.4 与现有代码的接入点

| 层 | 文件 / 位置 | 改动 |
|---|---|---|
| 前端渲染 | `src/components/Card.tsx` | 新增 `case 'diagram'`：默认渲染只读缩略图（React Flow 静态/`fitView`），双击或「编辑」按钮打开全屏编辑器 |
| 前端渲染 | `src/components/MarkdownRenderer.tsx`（P0） | `mermaid` 代码块工具条加「编辑」按钮 → `parseMermaid` → 打开 `DiagramEditor` |
| 编辑器 | 新增 `src/components/DiagramEditor.tsx` + `DiagramNode.tsx` + `diagram.module.css` | P2 主组件：画布 + 工具栏 + 属性栏 |
| 命令层 | 新增 `src-tauri/src/commands/diagram.rs` | `save_diagram` / `load_diagram` / `export_diagram_png` / `export_diagram_mermaid` |
| 动作层 | `src-tauri/src/ai/actions.rs`（P1） | 生成流程图结果提供「编辑」入口 |
| 搜索 | FTS5 索引 | 对 `diagram.mermaid` 文本建索引（节点 label + 边 label 拼接），使「按文字搜流程图」可用 |
| 主题 | `theme.css` | React Flow 样式变量跟随 6 套主题，节点配色用 `--accent` 等 CSS 变量 |

### 3.5 UI / 交互设计（贴合 PastePanda 紧凑玻璃风）

- **编辑面板布局**：左工具栏（添加节点 / 形状选择）、中画布（`ReactFlow` + `Controls` + `MiniMap` + `Background`）、右属性栏（选中节点改文字/形状/颜色，选中边改标签/类型）。
- **顶部操作条**：自动布局（dagre）、方向切换（TD/LR）、导入 mermaid、导出 PNG/SVG/mermaid、保存。
- **主题联动**：编辑器配色跟随应用当前主题；节点形状用 `--glass-*` / `--accent` 令牌。
- **紧凑优先**：单行控件、细分割线、hover 淡底，与现有 dialog（380/400/420/460/520px）宽度规范一致。

### 3.6 P2 内部分阶段

| 子阶段 | 内容 | 工作量 |
|---|---|---|
| P2.0 内核接入 | 装 `@xyflow/react`，`DiagramEditor` 骨架，只读渲染 `diagram` 条目 | 2 人日 |
| P2.1 编辑能力 | 增删节点/边、属性栏、撤销重做（zundo）、自动布局（dagre） | 3 人日 |
| P2.2 往返 | mermaid→图 导入（openflowkit-core）、图→mermaid 导出 serializer | 2 人日 |
| P2.3 导出与集成 | 导出 PNG/SVG、P0「打开为可编辑」、P1「编辑」入口、FTS5 索引 `diagram.mermaid` | 2 人日 |
| P2.4 打磨 | 主题联动、键盘快捷键、空态引导、大图性能（>200 节点视口裁剪） | 1 人日 |
| **合计** | | **~10 人日** |

### 3.7 风险与对策

| 风险 | 对策 |
|---|---|
| mermaid→图 解析不全（子图/复杂语法） | 用 openflowkit-core 覆盖常见 flowchart/state；不支持的语法降级为「纯 mermaid 文本卡片 + 提示，不可编辑」 |
| 包体积膨胀 | `@xyflow/react` 约 100KB+gzip 无关；dagre 40KB；elkjs 按需动态 import；mermaid 已在 P0 引入，不重复 |
| 大图性能 | 节点 >200 时考虑视口裁剪 / 简化渲染；dagre 同步布局加 loading 态 |
| 与 P0 双实现冲突 | `diagram` 类型**不**走 mermaid SVG 渲染，只读态用 React Flow 静态画布，避免两套渲染逻辑 |

### 3.8 验收标准（P2）

1. 新建流程图、拖拽、连线、改文字/形状、自动布局、撤销重做均可用。
2. 从任意 P0/P1 mermaid 一键打开为可编辑图；编辑后导出 mermaid 与原始语义一致（节点/边不丢、方向一致）。
3. 「复制为 mermaid」「复制为 PNG」成功，粘贴到外部（如 Markdown 编辑器 / 文档）正常。
4. 全部本地、无 CDN、无出网；FTS5 可按节点文字搜到该流程图。
5. `tsc` 0 / `vitest` 通过 / `cargo build` 0。

---

## 4. 三阶段依赖与推进顺序

```
P0 渲染(mermaid) ──► P1 AI生成(mermaid) ──► P2 交互编辑(diagram)
   │                   │                        │
   └── 共用 mermaid 文本协议做往返 ────────────┘
```

- **建议顺序**：P0 → P1 → P2。P2 依赖 P0 的文本协议与 `MarkdownRenderer`、P1 的生成入口。
- **可独立发布**：每阶段可单独发版；P2 在 P0/P1 之后，但 P2.0（只读渲染）可前置到 P0 同期。

---

## 5. 已确认决策（2026-08-12 用户拍板）

| # | 决策点 | 结论 | 备注 |
|---|---|---|---|
| 1 | 推进节奏 | **P0 → P1 → P2 顺序，现在开 P0** | 依赖清晰、每阶段可独立发布；P0 改动最小最快见效 |
| 2 | mermaid→图 解析 | **openflowkit-core 的 parseMermaid** | 省数天自研；冷门语法降级为纯 mermaid 文本卡片 |
| 3 | 自动布局 | **dagre + elkjs 都纳入** | elkjs 用动态 import，不进主包，仅复杂布局按需加载（用户明确要求，接受 1.5MB 按需代价） |
| 4 | 存储模型 | **新增 item_type = "diagram"** | JSON 存 nodes/edges 真值 + mermaid 副本；DB schema 不改 |

下一步：按项目规则（改代码前先出 2~3 个细分方案对比），我会对 **P0（mermaid 渲染）** 先给具体实现方案让你选，再落地代码。版本号只动 `tauri.conf.json`，提交由你手动指令触发。
