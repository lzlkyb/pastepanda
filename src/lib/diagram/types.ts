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
  /** 文字色（缺省跟随主题的 --diagram-node-text）。
   *  与 stroke 一样「默认值不入库」：缺省时整个字段不写，否则序列化串会和
   *  新建节点不等，而「未保存」是靠序列化串比对基线判的——会凭空亮红点。 */
  textColor?: string;
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

/**
 * 连线线型。对齐 Mermaid 的三种连接符：`-->` 实线 / `-.->` 虚线 / `==>` 粗线。
 *
 * 解析器一直认得这三种（见 CONNECTOR_RE），但以前没把“是哪种”存下来，
 * 导出时一律写回 `-->`——导入一个带虚线的图，往返一轮线型就没了。
 *
 * 注：Mermaid 的无箭头连接（`---` / `===`）仍会在往返后长出箭头，
 * 因为本项目的模型里没有“有无箭头”这一维（流程图里罕用，暂不引入）。
 */
export type EdgeLine = "solid" | "dashed" | "thick";

const EDGE_LINES: ReadonlySet<string> = new Set<EdgeLine>(["solid", "dashed", "thick"]);

export function asEdgeLine(v: unknown): EdgeLine {
  return typeof v === "string" && EDGE_LINES.has(v) ? (v as EdgeLine) : "solid";
}

/** 从边上读线型。data 是 Record<string, unknown>，直接读拿到的是 unknown，得过一道收敛。 */
export function edgeLineOf(e: DEdge): EdgeLine {
  return asEdgeLine(e.data?.line);
}

/** 线型 → Mermaid 连接符 */
const LINE_CONNECTOR: Record<EdgeLine, string> = {
  solid: "-->",
  dashed: "-.->",
  thick: "==>",
};

/** Mermaid 连接符 → 线型。`-.-` 开头是虚线，`=` 开头是粗线，其余实线。 */
export function lineOfConnector(conn: string): EdgeLine {
  if (conn.startsWith("-.")) return "dashed";
  if (conn.startsWith("=")) return "thick";
  return "solid";
}
/* ===================== 区域框（subgraph 分组） =====================
 *
 * 分组用一个单独的 group 节点表达，混在 doc.nodes 里，**全部是绝对坐标**。
 *
 * 为什么不用 React Flow 原生的 parentId 容器：原生容器会把子节点的 position
 * 变成**相对父节点**的坐标，而本文件的 pickEdgeHandles() 直接拿 position 比大小
 * 判断上下行——父子混算之后所有回边的锚点判定全部作废；
 * 序列化、AI 展开、复制粘贴也得跟着改。
 *
 * 归属不存字段，而是**按几何包含算**（节点中心落在框里 = 属于该框）：
 * 拖出框即脱组，不会留下一个指向旧框的残留字段。
 */

export const GROUP_TYPE = "group";

/** 新建区域框的默认尺寸 */
export const GROUP_W = 260;
export const GROUP_H = 180;

/** 从 Mermaid 导入时，框比成员包围盒向外撑多少 */
export const GROUP_PAD = 24;
/** 框顶额外留的位置：标题栏骑在框的上边上，不留就会压到第一行节点 */
export const GROUP_HEAD_ROOM = 18;

/**
 * 区域框压在节点下面。
 * React Flow 的 calculateZ 是 `zIndex + (selected ? SELECTED_NODE_Z : 0)`，
 * 所以选中时它会翻到最上层——选中态的底色在 CSS 里被抽掉，就是为了这一帧不糊住框内节点。
 */
export const GROUP_Z = -1;

/**
 * 拖拽句柄的选择器。**必须是不过 CSS Modules 哈希的全局类名**，
 * 因为 React Flow 拿着它去 querySelector，拿不到哈希后的名字。
 * 只能按标题栏拖：框体是 pointer-events:none，否则整块区域吃走鼠标事件，
 * 框内空白处就无法框选、也拖不动画布。
 */
export const GROUP_DRAG_HANDLE = ".diagram-group-head";

export function isGroup(n: DNode): boolean {
  return n.type === GROUP_TYPE;
}

/** 区域框的唯一构造入口（parseDiagram / parseMermaid / 手动新建 共用），
 *  避免 zIndex / dragHandle 这两个容易漏的字段在三处各写一遍。 */
export function makeGroup(
  id: string,
  position: { x: number; y: number },
  size: { w: number; h: number },
  data: { label: string; color?: string },
): DNode {
  return {
    id,
    type: GROUP_TYPE,
    position,
    width: size.w,
    height: size.h,
    zIndex: GROUP_Z,
    dragHandle: GROUP_DRAG_HANDLE,
    data: { label: data.label, ...(data.color ? { color: data.color } : {}) },
  };
}

/** 区域框的矩形（没存尺寸的旧数据回落默认值） */
function groupRect(g: DNode): { x: number; y: number; w: number; h: number } {
  return { x: g.position.x, y: g.position.y, w: g.width ?? GROUP_W, h: g.height ?? GROUP_H };
}

/**
 * 算每个区域框的成员：节点**中心点**落在框矩形内即属于该框。
 *
 * 用中心而不是包围盒全含：否则一个只露出一角的节点既不算入组、拖回去也不算，手感发粘。
 * 重叠时取**面积最小**的框，嵌套 subgraph 就自然成立（内层框更小，赢过外层）。
 */
export function groupMembers(nodes: DNode[]): Map<string, string[]> {
  const groups = nodes.filter(isGroup);
  const out = new Map<string, string[]>(groups.map((g) => [g.id, [] as string[]]));
  if (groups.length === 0) return out;
  for (const n of nodes) {
    if (isGroup(n)) continue;
    const { w, h } = nodeSize(n);
    const cx = n.position.x + w / 2;
    const cy = n.position.y + h / 2;
    let bestId: string | null = null;
    let bestArea = Infinity;
    for (const g of groups) {
      const r = groupRect(g);
      if (cx < r.x || cx > r.x + r.w || cy < r.y || cy > r.y + r.h) continue;
      const area = r.w * r.h;
      if (area < bestArea) {
        bestArea = area;
        bestId = g.id;
      }
    }
    if (bestId) out.get(bestId)!.push(n.id);
  }
  return out;
}

/**
 * 区域框之间的嵌套关系：parentId -> 子框。顶层框挂在 key = "" 下。
 * “被包含”按矩形全含判，父取**包含它的最小那个框**（与成员归属同一套规则）。
 * 导出 Mermaid 时靠它把 subgraph 写成嵌套的，否则导入时的嵌套一导出就踩平了。
 */
export function groupTree(groups: DNode[]): Map<string, DNode[]> {
  const tree = new Map<string, DNode[]>([["", [] as DNode[]]]);
  groups.forEach((g) => tree.set(g.id, []));
  for (const g of groups) {
    const r = groupRect(g);
    let parentId = "";
    let bestArea = Infinity;
    for (const h of groups) {
      if (h.id === g.id) continue;
      const hr = groupRect(h);
      const contains =
        hr.x <= r.x && hr.y <= r.y && hr.x + hr.w >= r.x + r.w && hr.y + hr.h >= r.y + r.h;
      if (!contains) continue;
      const area = hr.w * hr.h;
      if (area < bestArea) {
        bestArea = area;
        parentId = h.id;
      }
    }
    tree.get(parentId)!.push(g);
  }
  return tree;
}

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
    // 手动缩放过的尺寸。只收正数：0 / 负数 / NaN 都会让 React Flow 把节点渲染成一条线，
    // 而且一旦写进去就拖不回来了（手柄也跟着塌陷）。
    const size = (v: unknown): number | undefined =>
      typeof v === "number" && Number.isFinite(v) && v > 0 ? v : undefined;
    const nodes: DNode[] = raw.nodes.map((n, i) => {
      const id = n?.id || `n${i}`;
      const position = n?.position || { x: 40 + (i % 4) * 60, y: 40 + Math.floor(i / 4) * 60 };
      // 区域框走它自己的构造入口：zIndex / dragHandle 不入库（它们是渲染约定、不是数据），
      // 每次读盘重新盖上，旧文档也能直接拿到新行为。
      if (n?.type === GROUP_TYPE) {
        return makeGroup(
          id,
          position,
          { w: size(n?.width) ?? GROUP_W, h: size(n?.height) ?? GROUP_H },
          {
            label: typeof n?.data?.label === "string" ? n.data.label : "",
            color: typeof n?.data?.color === "string" ? n.data.color : undefined,
          },
        );
      }
      return {
      id,
      type: "diagram",
      position,
      ...(size(n?.width) !== undefined ? { width: size(n?.width) } : {}),
      ...(size(n?.height) !== undefined ? { height: size(n?.height) } : {}),
      data: {
        label: typeof n?.data?.label === "string" ? n.data.label : "",
        color: n?.data?.color,
        shape: asShape(n?.data?.shape),
        fontSize: typeof n?.data?.fontSize === "number" ? n.data.fontSize : undefined,
        focal: n?.data?.focal === true ? true : undefined,
        stroke: typeof n?.data?.stroke === "string" ? n.data.stroke : undefined,
        textColor: typeof n?.data?.textColor === "string" ? n.data.textColor : undefined,
      },
      };
    });
    // 连线只能接非区域框的节点：区域框不出 Handle，指向它的边渲染时会掉到默认锚点上、拿不到位置
    const ids = new Set(nodes.filter((n) => !isGroup(n)).map((n) => n.id));
    const edges: DEdge[] = (Array.isArray(raw.edges) ? raw.edges : [])
      .filter((e) => e && ids.has(e.source) && ids.has(e.target))
      .map((e, i) => {
        // autoRoute 不在 React Flow 的 Edge 类型里，是本项目自己落盘的字段
        const stored = e as DEdge & { autoRoute?: boolean; line?: unknown };
        // 没存过锚点 = 旧文档或导入/AI 生成的裸边，一律当自动边，交给下面 routeAutoEdges 重算
        const auto = stored.autoRoute === true || typeof e.sourceHandle !== "string";
        const line = asEdgeLine(stored.line);
        // autoRoute 与 line 两个字段都可能缺席，都缺席时就不要给个空对象
        const data: Record<string, unknown> = {};
        if (auto) data.autoRoute = true;
        if (line !== "solid") data.line = line;
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
          data: Object.keys(data).length > 0 ? data : undefined,
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
    nodes: doc.nodes.map((n) => (isGroup(n) ? {
      // 区域框：只落盘 type / 位置 / 尺寸 / 标题 / 颜色。
      // 成员列表**不落盘**——归属是几何算出来的，存一份就会与真实位置脱节。
      id: n.id,
      type: GROUP_TYPE,
      position: n.position,
      width: n.width ?? GROUP_W,
      height: n.height ?? GROUP_H,
      data: { label: n.data.label, ...(n.data.color ? { color: n.data.color } : {}) },
    } : {
      id: n.id,
      position: n.position,
      // 手动缩放的尺寸在 node 顶层（NodeResizer 写的就是这两个字段），不在 data 里。
      // 没缩放过就不写：默认值入库会让序列化串与新建节点不等，凭空亮「未保存」红点。
      ...(typeof n.width === "number" ? { width: n.width } : {}),
      ...(typeof n.height === "number" ? { height: n.height } : {}),
      data: {
        label: n.data.label,
        color: n.data.color,
        shape: n.data.shape || "rect",
        ...(typeof n.data.fontSize === "number" ? { fontSize: n.data.fontSize } : {}),
        ...(n.data.focal ? { focal: true } : {}),
        ...(typeof n.data.stroke === "string" ? { stroke: n.data.stroke } : {}),
        ...(typeof n.data.textColor === "string" ? { textColor: n.data.textColor } : {}),
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
      // 线型同理；与 autoRoute 一样平铺在边对象顶层，而不是嵌在 data 里，
      // 保持落盘格式扁平、与已存文档兼容（旧文档没这个字段 → asEdgeLine 回落 solid）
      line: edgeLineOf(e) === "solid" ? undefined : edgeLineOf(e),
    })),
  });
}

/** 节点标签拼接（写入 history.text，供 FTS 检索 + 卡片标题） */
export function nodeLabelsText(doc: DiagramDoc): string {
  const labels = doc.nodes.map((n) => (n.data.label || "").trim()).filter(Boolean);
  return labels.join(" / ");
}

/** 卡片默认标题（无标签时）。计数不算区域框——它不是“节点”，
 *  两个节点加一个框显示「3 节点」会让人以为丢了一个。 */
export function diagramTitle(doc: DiagramDoc): string {
  const t = nodeLabelsText(doc);
  return t || `流程图（${doc.nodes.filter((n) => !isGroup(n)).length} 节点）`;
}

/** 转 Mermaid 文本（导出 / 互操作 / AI 生成回灌都用它） */
export function toMermaid(doc: DiagramDoc): string {
  // 分组用 g 前缀、节点用 n 前缀，两套计数分开。
  // 不能统一数：那样导出会写出 `subgraph n1[…]` 这种看着像节点的块名，
  // 而且一旦将来改了遍历顺序，组名与节点名就可能撞上。
  const idMap = new Map<string, string>();
  let gi = 0;
  let ni = 0;
  doc.nodes.forEach((n) => idMap.set(n.id, isGroup(n) ? `g${++gi}` : `n${++ni}`));
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
  const esc = (s: string) => s.replace(/"/g, '\\"').replace(/\n/g, " ");
  const declOf = (n: DNode) =>
    `${idMap.get(n.id)}` + shapeWrappers[n.data.shape || "rect"](esc(n.data.label || ""));

  const lines: string[] = ["flowchart TD"];

  // 先写 subgraph 块，再写没入组的节点，最后写边。
  // 每个节点只能声明一次：mermaid 里重复声明不报错，但节点会被归到先出现的那个 subgraph，
  // 写两遍就等于把归属交给了行序。
  const groups = doc.nodes.filter(isGroup);
  const flow = doc.nodes.filter((n) => !isGroup(n));
  const byId = new Map(flow.map((n) => [n.id, n]));
  const members = groupMembers(doc.nodes);
  const tree = groupTree(groups);
  const emitted = new Set<string>();

  const emitGroup = (g: DNode, depth: number) => {
    const ids = members.get(g.id) ?? [];
    const kids = tree.get(g.id) ?? [];
    // 既没成员也没子框的空框不导：mermaid 会画出一个空盒子，往返回来又变成零尺寸。
    // 代价：刚拖出来还没装东西的空框导出会丢（属于已知取舍，JSON 落盘不丢）。
    if (ids.length === 0 && kids.length === 0) return;
    const pad = "  ".repeat(depth + 1);
    lines.push(`${pad}subgraph ${idMap.get(g.id)}["${esc(g.data.label || "分组")}"]`);
    ids.forEach((id) => {
      const n = byId.get(id);
      if (!n) return;
      emitted.add(id);
      lines.push(`${pad}  ${declOf(n)}`);
    });
    kids.forEach((k) => emitGroup(k, depth + 1));
    lines.push(`${pad}end`);
  };

  (tree.get("") ?? []).forEach((g) => emitGroup(g, 0));
  flow.forEach((n) => {
    if (emitted.has(n.id)) return;
    lines.push(`  ${declOf(n)}`);
  });

  doc.edges.forEach((e) => {
    const from = idMap.get(e.source);
    const to = idMap.get(e.target);
    if (!from || !to) return;
    const label = e.label ? `|${String(e.label).replace(/\|/g, " ")}|` : "";
    lines.push(`  ${from} ${LINE_CONNECTOR[edgeLineOf(e)]}${label} ${to}`);
  });
  return lines.join("\n");
}

/** 未手动缩放的节点的估算尺寸。真实渲染尺寸由 CSS 决定（min-width 96 / max-width 220），
 *  这里只是给布局与锚点判定用的中间值。 */
export const NODE_W = 168;
export const NODE_H = 64;

/** 纵向差小于一个节点高就当同一层，不算上下行 */
const SAME_RANK_DY = NODE_H;

/**
 * 节点的实际尺寸。
 *
 * **不能再用写死的 168×64**：NodeResizer 把手动缩放的结果写在 `node.width` /
 * `node.height` 顶层字段上（见 @xyflow 的 dimensions change：`element.width = ...`）。
 * 拉到 300px 宽的节点如果在布局里仍按 168 算，相邻节点会压上去；
 * centerOf 算偏后回边还会挑错锚点。
 *
 * measured 是 React Flow 渲染后回填的实测值（未手动缩放时就靠它拿到真实宽高），
 * 纯数据场景（单测 / 导入后还没渲染）拿不到，才回落到常量。
 */
export function nodeSize(n: DNode): { w: number; h: number } {
  const m = (n as DNode & { measured?: { width?: number; height?: number } }).measured;
  return {
    w: n.width ?? m?.width ?? NODE_W,
    h: n.height ?? m?.height ?? NODE_H,
  };
}

function centerOf(n: DNode): { x: number; y: number } {
  const { w, h } = nodeSize(n);
  return { x: n.position.x + w / 2, y: n.position.y + h / 2 };
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

/**
 * dagre 自动布局（自上而下），返回新位置后的文档副本。
 *
 * 有区域框时走 dagre 的**复合图**（compound）：把框当 cluster、成员 setParent 进去，
 * dagre 会保证同组节点排在一块儿，并直接算出 cluster 的 x/y/width/height，拿来当框的新矩形。
 * 不能简单地「先布局再把框贴到成员包围盒」：dagre 不知道分组时会把同组节点打散，
 * 贴出来的框会把别的节点圈进去——归属是几何算的，下一次就错了。
 *
 * 空框（没成员）不进图：dagre 对无子节点的 cluster 不给尺寸，会把位置算成 NaN。
 */
export function autoLayout(doc: DiagramDoc): DiagramDoc {
  const members = groupMembers(doc.nodes);
  const parentOf = new Map<string, string>();
  members.forEach((ids, gid) => ids.forEach((id) => parentOf.set(id, gid)));
  const clusters = doc.nodes.filter((n) => isGroup(n) && (members.get(n.id)?.length ?? 0) > 0);

  const g = new dagre.graphlib.Graph({ compound: clusters.length > 0 });
  // 间距对着 168×64 的节点给：太挤的话斜线会贴着节点边缘走，回边也没地方绕
  g.setGraph({ rankdir: "TB", nodesep: 80, ranksep: 100, marginx: 24, marginy: 24 });
  g.setDefaultEdgeLabel(() => ({}));
  clusters.forEach((c) => g.setNode(c.id, {}));
  doc.nodes.forEach((n) => {
    if (isGroup(n)) return;
    const { w, h } = nodeSize(n);
    g.setNode(n.id, { width: w, height: h });
    const p = parentOf.get(n.id);
    if (p) g.setParent(n.id, p);
  });
  doc.edges.forEach((e) => g.setEdge(e.source, e.target));
  dagre.layout(g);
  const nodes = doc.nodes.map((n) => {
    const p = g.node(n.id) as { x?: number; y?: number; width?: number; height?: number } | undefined;
    if (!p || p.x == null || p.y == null) return n; // 未入图的空框：原位不动
    if (isGroup(n)) {
      if (!p.width || !p.height) return n;
      return {
        ...n,
        position: { x: Math.round(p.x - p.width / 2), y: Math.round(p.y - p.height / 2) },
        width: Math.round(p.width),
        height: Math.round(p.height),
      };
    }
    // dagre 返回的是中心点，换回左上角时要用**该节点自己的**尺寸，不是常量
    const { w, h } = nodeSize(n);
    return { ...n, position: { x: Math.round(p.x - w / 2), y: Math.round(p.y - h / 2) } };
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

/** 节点之间的连接符（含可选的 |说明|）：--> -.-> ==> --- === 及其加长写法。
 *  第 1 组捕连接符本身（用于定线型），第 2 组捕说明文字。 */
const CONNECTOR_RE = /^\s*(-\.-*->|-{2,}>|={2,}>|-{2,}|={2,})\s*(?:\|([^|]*)\|\s*)?/;

/** `subgraph …` 行。第 1 组是后面的全部内容（id + 可选包裹，或直接一个标题）。
 *  它必须在 DIRECTIVE_RE 之前试，因为 DIRECTIVE_RE 也匹配 subgraph。 */
const SUBGRAPH_RE = /^subgraph\s+(.+)$/i;

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
  const edges: { source: string; target: string; label?: string; line: EdgeLine }[] = [];
  const byId = new Map<string, { id: string; label: string; shape: NodeShape }>();
  // subgraph 栈：遇 subgraph 入栈、遇 end 出栈，期间出现的节点记进栈上**所有**组，
  // 这样嵌套 subgraph 时外层框也包得住内层的节点。
  const stack: string[] = [];
  const groups: { id: string; label: string; depth: number; nodeIds: string[] }[] = [];
  const groupById = new Map<string, (typeof groups)[number]>();

  // 同一节点可能先在连线里以裸 id 出现、之后才带标签声明（反之亦然），
  // 所以后到的标签 / 形状要能补写进先建的空节点，不能简单「见过就跳过」。
  const pushNode = (id: string, label?: string, shape?: NodeShape) => {
    const exist = byId.get(id);
    if (!exist) {
      const n = { id, label: label ?? "", shape: shape ?? ("rect" as NodeShape) };
      byId.set(id, n);
      nodes.push(n);
    } else {
      if (label && !exist.label) exist.label = label;
      if (shape && exist.shape === "rect") exist.shape = shape;
    }
    // 归组：栈上每一层都记一份（去重）
    for (const gid of stack) {
      const g = groupById.get(gid);
      if (g && !g.nodeIds.includes(id)) g.nodeIds.push(id);
    }
  };

  src.split(/\r?\n/).forEach((raw) => {
    let rest = raw.trim();
    if (!rest || rest.startsWith("%%")) return;

    // subgraph / end 要在 DIRECTIVE_RE 之前拦：那条正则把它俩当非图元声明整行丢弃，
    // 以前导入一个带分组的图，分组就静静没了。
    const sg = rest.match(SUBGRAPH_RE);
    if (sg) {
      // 三种写法：`subgraph 标题` / `subgraph id[标题]` / `subgraph id["标题"]`
      const body = sg[1].trim();
      const nm = body.match(NODE_TOKEN_RE);
      const hasWrapper = Boolean(nm && nm[2]);
      const id = hasWrapper ? nm![1] : `sg${groups.length + 1}`;
      const label = hasWrapper ? shapeAndLabel(nm![2]!).label : unquote(body);
      const g = { id, label, depth: stack.length, nodeIds: [] as string[] };
      groups.push(g);
      groupById.set(id, g);
      stack.push(id);
      return;
    }
    if (/^end\b/i.test(rest)) {
      stack.pop();
      return;
    }

    if (DIRECTIVE_RE.test(rest)) return;
    let prev: string | null = null;
    let pendingLabel: string | undefined;
    let pendingLine: EdgeLine = "solid";
    // NODE_TOKEN_RE 至少吞 1 个字符、CONNECTOR_RE 至少吞 2 个，rest 严格变短，不会死循环。
    for (;;) {
      const nm = rest.match(NODE_TOKEN_RE);
      if (!nm) break;
      const id = nm[1];
      const parsed = nm[2] ? shapeAndLabel(nm[2]) : null;
      pushNode(id, parsed?.label, parsed?.shape);
      if (prev) edges.push({ source: prev, target: id, label: pendingLabel, line: pendingLine });
      prev = id;
      rest = rest.slice(nm[0].length);
      const cm = rest.match(CONNECTOR_RE);
      if (!cm) break;
      pendingLine = lineOfConnector(cm[1]);
      pendingLabel = cm[2]?.trim() || undefined;
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
      // solid 不入库：它是默认值，edgeLineOf 读不到时自然回落成 solid，存了只是噪声
      data: { ...AUTO_ROUTE_DATA, ...(e.line !== "solid" ? { line: e.line } : {}) },
    })),
  };
  // autoLayout 会顺手把锚点算好（routeAutoEdges）
  const laid = autoLayout(doc);
  if (groups.length === 0) return laid;

  // 区域框在**布局之后**才能生成：它的矩形就是成员的包围盒，
  // 而成员位置要等 dagre 排完才知道。
  const pos = new Map(laid.nodes.map((n) => [n.id, n]));
  const maxDepth = groups.reduce((m, g) => Math.max(m, g.depth), 0);
  const boxes: DNode[] = [];
  // 已用掉的 id（先装上所有图元节点，每造一个框再补进去）。
  // 两种撞车都得防：手写的 mermaid 里 subgraph 的 id 可能和某个节点同名（两者在 mermaid 里
  // 是两个命名空间），也可能两个 subgraph 自己重名。到了本项目里它们同在 doc.nodes
  // 一个数组里——重名会让 React Flow 拿到两个同 id 节点，渲染与选中都会错乱。
  const usedIds = new Set(pos.keys());
  for (const g of groups) {
    const ns = g.nodeIds.map((id) => pos.get(id)).filter((n): n is DNode => Boolean(n));
    if (ns.length === 0) continue; // 空 subgraph：无处定位，不生成
    let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const n of ns) {
      const { w, h } = nodeSize(n);
      x0 = Math.min(x0, n.position.x);
      y0 = Math.min(y0, n.position.y);
      x1 = Math.max(x1, n.position.x + w);
      y1 = Math.max(y1, n.position.y + h);
    }
    // 外层框给更大的内边距：嵌套时外层的成员集包含内层，同一个 padding 会让两个框重合，
    // 而归属取面积最小的框——重合时就变成拼遍历顺序了。
    const pad = GROUP_PAD + (maxDepth - g.depth) * 14;
    let boxId = g.id;
    for (let seq = 1; usedIds.has(boxId); seq += 1) boxId = `${g.id}__grp${seq}`;
    usedIds.add(boxId);
    boxes.push(
      makeGroup(
        boxId,
        { x: Math.round(x0 - pad), y: Math.round(y0 - pad - GROUP_HEAD_ROOM) },
        { w: Math.round(x1 - x0 + pad * 2), h: Math.round(y1 - y0 + pad * 2 + GROUP_HEAD_ROOM) },
        { label: g.label },
      ),
    );
  }
  // 框排在前面：与 zIndex:-1 一致，也让序列化结果稳定
  return { ...laid, nodes: [...boxes, ...laid.nodes] };
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
  // 有区域框时直接转 dagre 的复合图。
  // elk 要支持分组得把 children 写成嵌套结构（本批未做）；不转的话框会停在原地，
  // 把布局后跑过来的其它节点圈进去——归属是几何算的，那就是真把分组改错了。
  if (doc.nodes.some(isGroup)) return autoLayout(doc);
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
    children: doc.nodes.map((n) => {
      const { w, h } = nodeSize(n);
      return { id: n.id, width: w, height: h };
    }),
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
