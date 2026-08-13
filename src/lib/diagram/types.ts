/**
 * 流程图数据模型与互操作工具。
 *
 * 存储：diagram 复用 history 表，JSON 存进 content 字段；text 字段承载
 * 节点标签拼接串（供 FTS 全文检索命中）。本文件只定义纯函数，不含任何
 * React / Tauri 依赖，便于单测与全屏窗口 / 内嵌编辑器共用。
 */
import dagre from "@dagrejs/dagre";
import type { Node, Edge } from "@xyflow/react";

/**
 * 节点形状。取值集**故意对齐 Mermaid 的形状词汇**：流程图是 Mermaid 双向闭环
 * （导入 / 导出 / AI 生成都走它），加一个 Mermaid 表达不了的形状，一导出就丢，往返就破。
 *
 * ellipse 对应 Mermaid 的 `((x))`（圆形）。名字没改成 circle 是为了向后兼容——
 * 已存的图里写的是 "ellipse"，改 key 会让它们的形状读不出来。
 */
export type NodeShape =
  | "rect"
  | "round"
  | "pill"
  | "ellipse"
  | "diamond"
  | "hexagon"
  | "parallelogram"
  | "trapezoid"
  | "cylinder"
  | "subroutine"
  | "text";

const SHAPE_KEYS: ReadonlySet<string> = new Set<NodeShape>([
  "rect", "round", "pill", "ellipse", "diamond",
  "hexagon", "parallelogram", "trapezoid", "cylinder", "subroutine", "text",
]);

/**
 * 把任意值收敛成合法形状。
 * 不能直接 `as NodeShape`：旧文档 / 手改的 JSON 里冒出一个未知值时，
 * 组件里的 styles[`shape_${shape}`] 会取到 undefined，className 里就出现字面量 "undefined"。
 */
export function asShape(v: unknown): NodeShape {
  return typeof v === "string" && SHAPE_KEYS.has(v) ? (v as NodeShape) : "rect";
}

/**
 * 用 clip-path 裁形的形状。它们的描边与底色由伪元素画，`.node` 自身必须保持透明，
 * 所以不能叠 `data-colored` 那套「描边 + 淡底色」——否则裁剪图形后面会露出一个矩形底色块。
 */
export const CLIPPED_SHAPES: ReadonlySet<NodeShape> = new Set<NodeShape>([
  "diamond",
  "hexagon",
  "parallelogram",
  "trapezoid",
]);

/** React Flow v12 要求节点 data 必须是 Record<string, unknown> 的子类型 */
export interface DiagramNodeData {
  label: string;
  /** 节点强调色（左侧色条 / 顶部色带），缺省走主题强调色 */
  color?: string;
  /** 形状，缺省 rect */
  shape?: NodeShape;
  /** 字号（px），缺省走节点默认 13px */
  fontSize?: number;
  /** 焦点路径节点：渐变描边强调（设计稿「设为焦点路径」） */
  focal?: boolean;
  /** 描边色（独立覆盖默认边框色；缺省跟随主题边框） */
  stroke?: string;
  [key: string]: unknown;
}

export type DNode = Node<DiagramNodeData>;
export type DEdge = Edge;

export interface DiagramDoc {
  version: number;
  nodes: DNode[];
  edges: DEdge[];
}

export const DIAGRAM_VERSION = 1;

/**
 * 非手绘连线（Mermaid 导入 / AI 生成 / 旧文档）的默认锚点。
 *
 * **必须显式指定**：节点有 top/right/bottom/left 四个 handle，而 edge 没写
 * sourceHandle/targetHandle 时 React Flow 取 `handles[0]`（见 @xyflow/system：
 * `handleId ? handles.find(...) : handles[0]`），而 DiagramNode 里第一个声明的是 **top**。
 * 结果每条线都成了「源节点顶部 → 目标节点顶部」，在 dagre 自上而下的布局里
 * 看上去就是线从上方绕出去、接到下一个节点的头顶——“节点没对上”。
 *
 * 手拖的连线不受影响：onConnect 会带上真实锚点。
 * 取 bottom → top 是因为自动布局（dagre rankdir=TB / elk DOWN）都是自上而下。
 */
export const DEFAULT_EDGE_HANDLES = { sourceHandle: "bottom", targetHandle: "top" } as const;

/**
 * 自动布线标记。置位的边会随节点位置重算锚点（导入 / AI 生成 / 旧文档）；
 * 手拖出来的边不带这个标记，锚点完全由用户决定，布局不得推翻。
 */
export const AUTO_ROUTE_DATA = { autoRoute: true } as const;
export const NODE_COLORS = [
  "#0284C7", "#8B5CF6", "#EC4899", "#10B981",
  "#F59E0B", "#EF4444", "#06B6D4", "#6366F1",
];

/** 空文档 */
export function emptyDoc(): DiagramDoc {
  return { version: DIAGRAM_VERSION, nodes: [], edges: [] };
}

/** 安全解析：任何非法内容都回退到空文档，绝不抛错（卡片渲染 / 编辑器首屏都依赖这点） */
export function parseDiagram(content: string | undefined | null): DiagramDoc {
  if (!content) return emptyDoc();
  try {
    const raw = JSON.parse(content) as Partial<DiagramDoc>;
    if (!raw || !Array.isArray(raw.nodes)) return emptyDoc();
    const nodes: DNode[] = raw.nodes.map((n, i) => ({
      id: n?.id || `n${i}`,
      type: "diagram",
      position: n?.position || { x: 40 + (i % 4) * 60, y: 40 + Math.floor(i / 4) * 60 },
      data: {
        label: typeof n?.data?.label === "string" ? n.data.label : "",
        color: n?.data?.color,
        shape: asShape(n?.data?.shape),
        fontSize: typeof n?.data?.fontSize === "number" ? n.data.fontSize : undefined,
        focal: n?.data?.focal === true ? true : undefined,
        stroke: typeof n?.data?.stroke === "string" ? n.data.stroke : undefined,
      },
    }));
    const ids = new Set(nodes.map((n) => n.id));
    const edges: DEdge[] = (Array.isArray(raw.edges) ? raw.edges : [])
      .filter((e) => e && ids.has(e.source) && ids.has(e.target))
      .map((e, i) => {
        // autoRoute 不在 React Flow 的 Edge 类型里，是本项目自己落盘的字段
        const stored = e as DEdge & { autoRoute?: boolean };
        // 没存过锚点 = 旧文档或导入/AI 生成的裸边，一律当自动边，交给下面 routeAutoEdges 重算
        const auto = stored.autoRoute === true || typeof e.sourceHandle !== "string";
        return {
          id: e.id || `e${i}`,
          source: e.source,
          target: e.target,
          // 先给默认值兜底：留 undefined 的话 React Flow 会用 top→top
          sourceHandle: typeof e.sourceHandle === "string" ? e.sourceHandle : DEFAULT_EDGE_HANDLES.sourceHandle,
          targetHandle: typeof e.targetHandle === "string" ? e.targetHandle : DEFAULT_EDGE_HANDLES.targetHandle,
          label: typeof e.label === "string" ? e.label : undefined,
          type: e.type || "smoothstep",
          animated: e.animated,
          data: auto ? { ...AUTO_ROUTE_DATA } : undefined,
        };
      });
    return { version: DIAGRAM_VERSION, nodes, edges: routeAutoEdges(nodes, edges) };
  } catch {
    return emptyDoc();
  }
}

export function serializeDiagram(doc: DiagramDoc): string {
  return JSON.stringify({
    version: DIAGRAM_VERSION,
    nodes: doc.nodes.map((n) => ({
      id: n.id,
      position: n.position,
      data: {
        label: n.data.label,
        color: n.data.color,
        shape: n.data.shape || "rect",
        ...(typeof n.data.fontSize === "number" ? { fontSize: n.data.fontSize } : {}),
        ...(n.data.focal ? { focal: true } : {}),
        ...(typeof n.data.stroke === "string" ? { stroke: n.data.stroke } : {}),
      },
    })),
    edges: doc.edges.map((e) => ({
      id: e.id,
      source: e.source,
      target: e.target,
      sourceHandle: e.sourceHandle ?? undefined,
      targetHandle: e.targetHandle ?? undefined,
      label: e.label,
      type: e.type,
      animated: e.animated,
      // 自动布线标记要落盘：重开后才分得清哪些边可以随布局重算、哪些是用户手定的
      autoRoute: e.data?.autoRoute === true ? true : undefined,
    })),
  });
}

/** 节点标签拼接（写入 history.text，供 FTS 检索 + 卡片标题） */
export function nodeLabelsText(doc: DiagramDoc): string {
  const labels = doc.nodes.map((n) => (n.data.label || "").trim()).filter(Boolean);
  return labels.join(" / ");
}

/** 卡片默认标题（无标签时） */
export function diagramTitle(doc: DiagramDoc): string {
  const t = nodeLabelsText(doc);
  return t || `流程图（${doc.nodes.length} 节点）`;
}

/** 转 Mermaid 文本（导出 / 互操作 / AI 生成回灌都用它） */
export function toMermaid(doc: DiagramDoc): string {
  const idMap = new Map<string, string>();
  doc.nodes.forEach((n, i) => idMap.set(n.id, `n${i + 1}`));
  // 与下方 SHAPE_WRAPPERS 一一对应，保证「导出 Mermaid → 再导入」形状不漂移。
  // 每种包裹符只能归一个形状用，共用会让形状在往返时丢失（之前 ellipse 与 pill 共用
  // (["x"]) 就出过这个问题）。text 在 mermaid 里没有对应形状，退化成 rect
  // （这一项无法往返，属于固有取舍）。
  const shapeWrappers: Record<NodeShape, (s: string) => string> = {
    rect: (s) => `["${s}"]`,
    round: (s) => `("${s}")`,
    pill: (s) => `(["${s}"])`,
    ellipse: (s) => `(("${s}"))`,
    diamond: (s) => `{"${s}"}`,
    hexagon: (s) => `{{"${s}"}}`,
    parallelogram: (s) => `[/"${s}"/]`,
    trapezoid: (s) => `[/"${s}"\\]`,
    cylinder: (s) => `[("${s}")]`,
    subroutine: (s) => `[["${s}"]]`,
    text: (s) => `["${s}"]`,
  };
  const lines: string[] = ["flowchart TD"];
  doc.nodes.forEach((n) => {
    const safe = (n.data.label || "").replace(/"/g, '\\"').replace(/\n/g, " ");
    const wrap = shapeWrappers[n.data.shape || "rect"];
    lines.push(`  ${idMap.get(n.id)}` + wrap(safe));
  });
  doc.edges.forEach((e) => {
    const from = idMap.get(e.source);
    const to = idMap.get(e.target);
    if (!from || !to) return;
    const label = e.label ? `|${String(e.label).replace(/\|/g, " ")}|` : "";
    lines.push(`  ${from} -->${label} ${to}`);
  });
  return lines.join("\n");
}

const NODE_W = 168;
const NODE_H = 64;

/** 纵向差小于一个节点高就当同一层，不算上下行 */
const SAME_RANK_DY = NODE_H;

function centerOf(n: DNode): { x: number; y: number } {
  return { x: n.position.x + NODE_W / 2, y: n.position.y + NODE_H / 2 };
}

/**
 * 按两端节点的相对位置挑锚点。
 *
 * 锚点不能是常量：全钉成 bottom→top 的话，下行边没问题，但**回边**（目标在上方，
 * 如「提示错误 → 重新登录」）会从源节点底部出发、继续向下、再绕一大圈爬回目标顶部，
 * 沿途压过中间的节点——这就是「线很乱」的来源。
 *
 * 三条规则：
 *  - 目标在下方（主干）：bottom → top，竖直向下
 *  - 目标在上方（回边）：同侧进出，从外侧绕回去。源在目标左边就走左侧，反之走右侧
 *    （布局通常已把分支末端推到那一侧的外缘，贴着外缘绕就不会压主干）
 *  - 大致平齐：横向直连
 */
export function pickEdgeHandles(
  source: DNode,
  target: DNode,
): { sourceHandle: string; targetHandle: string } {
  const s = centerOf(source);
  const t = centerOf(target);
  const dx = t.x - s.x;
  const dy = t.y - s.y;

  if (dy > SAME_RANK_DY) return { sourceHandle: "bottom", targetHandle: "top" };

  if (dy < -SAME_RANK_DY) {
    return dx >= 0
      ? { sourceHandle: "left", targetHandle: "left" }
      : { sourceHandle: "right", targetHandle: "right" };
  }

  return dx >= 0
    ? { sourceHandle: "right", targetHandle: "left" }
    : { sourceHandle: "left", targetHandle: "right" };
}

/**
 * 重算带 autoRoute 标记的边的锚点。节点位置一变（自动布局 / 拖动）就要重跑。
 * 手绘边不带标记，原样返回。
 */
export function routeAutoEdges(nodes: DNode[], edges: DEdge[]): DEdge[] {
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return edges.map((e) => {
    if (e.data?.autoRoute !== true) return e;
    const s = byId.get(e.source);
    const t = byId.get(e.target);
    if (!s || !t) return e;
    return { ...e, ...pickEdgeHandles(s, t) };
  });
}

/** dagre 自动布局（自上而下），返回新位置后的文档副本 */
export function autoLayout(doc: DiagramDoc): DiagramDoc {
  const g = new dagre.graphlib.Graph();
  // 间距对着 168×64 的节点给：太挤的话斜线会贴着节点边缘走，回边也没地方绕
  g.setGraph({ rankdir: "TB", nodesep: 80, ranksep: 100, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));
  doc.nodes.forEach((n) => {
    g.setNode(n.id, { width: NODE_W, height: NODE_H });
  });
  doc.edges.forEach((e) => g.setEdge(e.source, e.target));
  dagre.layout(g);
  const nodes = doc.nodes.map((n) => {
    const p = g.node(n.id);
    return { ...n, position: { x: Math.round(p.x - NODE_W / 2), y: Math.round(p.y - NODE_H / 2) } };
  });
  // 位置变了，自动边的锚点必须跟着重算，否则回边会沿着旧方向绕
  return { ...doc, nodes, edges: routeAutoEdges(nodes, doc.edges) };
}

/** 从模型 / 用户文本里抠出 mermaid 代码块（兼容 ```mermaid 围栏 / 裸 flowchart / 代码块） */
export function extractMermaid(text: string): string {
  const fence = text.match(/```(?:mermaid)?\s*\n([\s\S]*?)```/i);
  if (fence) return fence[1].trim();
  // 没有围栏：尝试截取第一个 flowchart/graph 起到结尾
  const idx = text.search(/\b(?:flowchart|graph)\b/i);
  if (idx >= 0) return text.slice(idx).trim();
  return text.trim();
}

/**
 * 节点形状的包裹符表，顺序即匹配优先级：双字符必须排在单字符前面，
 * 否则 ([x]) 会被 ( … ) 先抢走。与 toMermaid 的 shapeWrappers 一一对应。
 */
const SHAPE_WRAPPERS: { open: string; close: string; shape: NodeShape }[] = [
  { open: "([", close: "])", shape: "pill" },          // stadium
  { open: "[[", close: "]]", shape: "subroutine" },
  { open: "[(", close: ")]", shape: "cylinder" },
  { open: "((", close: "))", shape: "ellipse" },       // mermaid circle
  { open: "{{", close: "}}", shape: "hexagon" },
  { open: "[/", close: "/]", shape: "parallelogram" },
  { open: "[\\", close: "\\]", shape: "parallelogram" }, // mermaid 的反向平行四边形
  { open: "[/", close: "\\]", shape: "trapezoid" },
  { open: "[\\", close: "/]", shape: "trapezoid" },      // mermaid 的倒梯形
  { open: "[", close: "]", shape: "rect" },
  { open: "(", close: ")", shape: "round" },
  { open: "{", close: "}", shape: "diamond" },
];

/** 剥掉标签外层引号（toMermaid 会给标签加引号，并把内部的 " 转义成 \"） */
function unquote(s: string): string {
  const t = s.trim();
  const quoted =
    t.length >= 2 &&
    ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")));
  return quoted ? t.slice(1, -1).replace(/\\"/g, '"').trim() : t;
}

/**
 * 拆解包裹符 → 标签 + 形状。
 *
 * 必须按成对的前后缀逐个试，不能用一串 alternation 的 replace：
 * 那样 {"判断"} 的花括号、(["x"]) 的前缀都剥不掉，标签会带着残渣进画布。
 */
function shapeAndLabel(wrapper: string): { label: string; shape: NodeShape } {
  for (const w of SHAPE_WRAPPERS) {
    if (
      wrapper.length >= w.open.length + w.close.length &&
      wrapper.startsWith(w.open) &&
      wrapper.endsWith(w.close)
    ) {
      return {
        label: unquote(wrapper.slice(w.open.length, wrapper.length - w.close.length)),
        shape: w.shape,
      };
    }
  }
  return { label: unquote(wrapper), shape: "rect" };
}

/** 行首的「节点 id + 可选形状包裹」；包裹符按长度降序，惰性量词避免跨过右界 */
const NODE_TOKEN_RE =
  /^([A-Za-z0-9_]+)\s*(\(\[[\s\S]*?\]\)|\[\[[\s\S]*?\]\]|\(\([\s\S]*?\)\)|\{\{[\s\S]*?\}\}|\[[\s\S]*?\]|\([\s\S]*?\)|\{[\s\S]*?\})?/;

/** 节点之间的连接符（含可选的 |说明|）：--> -.-> ==> --- === 及其加长写法 */
const CONNECTOR_RE = /^\s*(?:-\.-*->|-{2,}>|={2,}>|-{2,}|={2,})\s*(?:\|([^|]*)\|\s*)?/;

/** 非图元的声明行（子图 / 样式 / 交互），直接跳过，否则会被当成节点 id */
const DIRECTIVE_RE = /^(?:flowchart|graph|subgraph|end|classDef|class|style|linkStyle|click|direction)\b/i;

/**
 * 容错解析 mermaid flowchart → 文档。
 *
 * 逐行按「节点 → 连接符 → 节点 → …」扫描，因此 `A[开始] --> B[处理]` 这种
 * 声明与连线写在同一行的主流写法（也是 AI 提示词里教模型输出的格式）能正确落地；
 * 旧实现用两条整行锚定的正则，这类行会被整行静默丢弃。
 * 同时支持链式写法 `A --> B --> C`。
 */
export function parseMermaid(text: string): DiagramDoc {
  const src = extractMermaid(text);
  const nodes: { id: string; label: string; shape: NodeShape }[] = [];
  const edges: { source: string; target: string; label?: string }[] = [];
  const byId = new Map<string, { id: string; label: string; shape: NodeShape }>();

  // 同一节点可能先在连线里以裸 id 出现、之后才带标签声明（反之亦然），
  // 所以后到的标签 / 形状要能补写进先建的空节点，不能简单「见过就跳过」。
  const pushNode = (id: string, label?: string, shape?: NodeShape) => {
    const exist = byId.get(id);
    if (!exist) {
      const n = { id, label: label ?? "", shape: shape ?? ("rect" as NodeShape) };
      byId.set(id, n);
      nodes.push(n);
      return;
    }
    if (label && !exist.label) exist.label = label;
    if (shape && exist.shape === "rect") exist.shape = shape;
  };

  src.split(/\r?\n/).forEach((raw) => {
    let rest = raw.trim();
    if (!rest || rest.startsWith("%%") || DIRECTIVE_RE.test(rest)) return;
    let prev: string | null = null;
    let pendingLabel: string | undefined;
    // NODE_TOKEN_RE 至少吞 1 个字符、CONNECTOR_RE 至少吞 2 个，rest 严格变短，不会死循环。
    for (;;) {
      const nm = rest.match(NODE_TOKEN_RE);
      if (!nm) break;
      const id = nm[1];
      const parsed = nm[2] ? shapeAndLabel(nm[2]) : null;
      pushNode(id, parsed?.label, parsed?.shape);
      if (prev) edges.push({ source: prev, target: id, label: pendingLabel });
      prev = id;
      rest = rest.slice(nm[0].length);
      const cm = rest.match(CONNECTOR_RE);
      if (!cm) break;
      pendingLabel = cm[1]?.trim() || undefined;
      rest = rest.slice(cm[0].length);
    }
  });

  const doc: DiagramDoc = {
    version: DIAGRAM_VERSION,
    nodes: nodes.map((n, i) => ({
      id: n.id,
      type: "diagram",
      position: { x: 60 + (i % 4) * 80, y: 60 + Math.floor(i / 4) * 80 },
      data: { label: n.label, shape: n.shape },
    })),
    edges: edges.map((e, i) => ({
      id: `e${i}`,
      source: e.source,
      target: e.target,
      label: e.label,
      type: "smoothstep",
      ...DEFAULT_EDGE_HANDLES,
      data: { ...AUTO_ROUTE_DATA },
    })),
  };
  // autoLayout 会顺手把锚点算好（routeAutoEdges）
  return autoLayout(doc);
}

/** elkjs 的最小图结构（只声明本模块用到的字段） */
interface ElkGraph {
  id: string;
  layoutOptions?: Record<string, string>;
  children: { id: string; width: number; height: number; x?: number; y?: number }[];
  edges: { id: string; sources: string[]; targets: string[] }[];
}

/**
 * elkjs 大图自动布局（动态 import，不进主包）。用于 >30 节点或需要更优正交排布的图。
 * 节点尺寸用估算常量；返回新位置后的文档副本。
 */
export async function autoLayoutElk(doc: DiagramDoc): Promise<DiagramDoc> {
  // 动态 import elkjs bundled（不进主包）；bundled 版内置布局逻辑，无需 web worker。
  // elkjs 未随包发类型声明，只能在 import 这一处放宽；图结构本身用下方 ElkGraph 约束。
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const elkMod: any = await import("elkjs/lib/elk.bundled.js");
  const ElkCtor = elkMod.default;
  const elk = new ElkCtor();
  const graph: ElkGraph = {
    id: "root",
    layoutOptions: {
      "elk.algorithm": "layered",
      "elk.direction": "DOWN",
      "elk.layered.spacing.nodeNodeBetweenLayers": "100",
      "elk.spacing.nodeNode": "80",
    },
    children: doc.nodes.map((n) => ({ id: n.id, width: NODE_W, height: NODE_H })),
    edges: doc.edges.map((e, i) => ({
      id: `elk_e${i}`,
      sources: [e.source],
      targets: [e.target],
    })),
  };
  const res = (await elk.layout(graph)) as ElkGraph;
  const pos = new Map<string, { x: number; y: number }>();
  for (const c of res.children ?? []) {
    if (c.x != null && c.y != null) pos.set(c.id, { x: c.x, y: c.y });
  }
  const nodes = doc.nodes.map((n) => {
    const p = pos.get(n.id);
    if (!p) return n;
    return { ...n, position: { x: Math.round(p.x), y: Math.round(p.y) } };
  });
  return { ...doc, nodes, edges: routeAutoEdges(nodes, doc.edges) };
}

let _seq = 0;
/** 生成唯一节点 id（避免与已有 id 冲突） */
export function newId(prefix = "n"): string {
  _seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${_seq.toString(36)}`;
}
