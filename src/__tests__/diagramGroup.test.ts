/**
 * 第三批的纯函数回归：区域框（几何包含）、节点缩放尺寸、文字色。
 *
 * 这三项都改了 lib/diagram/types.ts 里被布局与往返共用的几个函数，
 * 而它们的错在 UI 上表现为“线很乱 / 框圈错人”这种难归因的样子，所以在这里钉死。
 */
import { describe, it, expect } from "vitest";
import {
  parseMermaid, toMermaid, parseDiagram, serializeDiagram, diagramTitle,
  autoLayout, nodeSize, groupMembers, groupTree, makeGroup, isGroup,
  GROUP_Z, GROUP_DRAG_HANDLE, NODE_W, NODE_H,
  type DNode, type DiagramDoc,
} from "@/lib/diagram/types";

function node(id: string, x: number, y: number, extra: Partial<DNode> = {}): DNode {
  return { id, type: "diagram", position: { x, y }, data: { label: id }, ...extra };
}

describe("nodeSize（缩放后的尺寸接进布局）", () => {
  it("没缩放也没实测时回落到常量", () => {
    expect(nodeSize(node("a", 0, 0))).toEqual({ w: NODE_W, h: NODE_H });
  });

  it("手动缩放的 width/height 优先于实测值", () => {
    const n = node("a", 0, 0, { width: 300, height: 120, measured: { width: 168, height: 64 } } as Partial<DNode>);
    expect(nodeSize(n)).toEqual({ w: 300, h: 120 });
  });

  it("只有实测值时用实测值", () => {
    const n = node("a", 0, 0, { measured: { width: 96, height: 40 } } as Partial<DNode>);
    expect(nodeSize(n)).toEqual({ w: 96, h: 40 });
  });

  it("autoLayout 按节点自己的宽度排，宽节点不会与邻居重叠", () => {
    const doc: DiagramDoc = {
      version: 1,
      nodes: [
        node("wide", 0, 0, { width: 400 }),
        node("b", 0, 0),
        node("c", 0, 0),
      ],
      // b、c 同层（都从 wide 出来），横向相邻
      edges: [
        { id: "e1", source: "wide", target: "b" },
        { id: "e2", source: "wide", target: "c" },
      ],
    };
    const laid = autoLayout(doc);
    const w = laid.nodes.find((n) => n.id === "wide")!;
    // 实际宽度进了布局：它的中心与左上角差 200 而不是 84
    expect(w.width).toBe(400);
    const b = laid.nodes.find((n) => n.id === "b")!;
    const c = laid.nodes.find((n) => n.id === "c")!;
    // 两个子节点横向不重叠
    const [left, right] = b.position.x < c.position.x ? [b, c] : [c, b];
    expect(left.position.x + NODE_W).toBeLessThanOrEqual(right.position.x);
  });
});

describe("groupMembers（几何包含归属）", () => {
  const box = (id: string, x: number, y: number, w: number, h: number) =>
    makeGroup(id, { x, y }, { w, h }, { label: id });

  it("中心点落在框里就算成员", () => {
    // 节点默认 168×64，放在 (100,100) 时中心在 (184,132)
    const nodes = [box("g", 0, 0, 400, 300), node("a", 100, 100)];
    expect(groupMembers(nodes).get("g")).toEqual(["a"]);
  });

  it("拖出框即脱组（不靠字段，所以不会残留）", () => {
    const nodes = [box("g", 0, 0, 400, 300), node("a", 900, 900)];
    expect(groupMembers(nodes).get("g")).toEqual([]);
  });

  it("只露一角不算（用中心而不是相交）", () => {
    // 节点左上角在框右下边界附近，中心已经在框外
    const nodes = [box("g", 0, 0, 200, 200), node("a", 180, 180)];
    expect(groupMembers(nodes).get("g")).toEqual([]);
  });

  it("重叠时归面积最小的框（嵌套自然成立）", () => {
    const nodes = [
      box("outer", 0, 0, 600, 600),
      box("inner", 50, 50, 300, 300),
      node("a", 100, 100),
    ];
    const m = groupMembers(nodes);
    expect(m.get("inner")).toEqual(["a"]);
    expect(m.get("outer")).toEqual([]);
  });

  it("groupTree 把嵌套关系理出来，顶层挂在 key=\"\"", () => {
    const outer = box("outer", 0, 0, 600, 600);
    const inner = box("inner", 50, 50, 300, 300);
    const tree = groupTree([outer, inner]);
    expect(tree.get("")!.map((g) => g.id)).toEqual(["outer"]);
    expect(tree.get("outer")!.map((g) => g.id)).toEqual(["inner"]);
  });
});

describe("Mermaid subgraph 往返", () => {
  const SRC = [
    "flowchart TD",
    '  subgraph g1["登录校验"]',
    '    n1["读取账号"]',
    '    n2["校验密码"]',
    "  end",
    '  subgraph g2["失败处理"]',
    '    n4["提示错误"]',
    "  end",
    "  n1 --> n2",
    "  n2 -.->|失败| n4",
  ].join("\n");

  it("导入后生成两个区域框，成员分对", () => {
    const doc = parseMermaid(SRC);
    const groups = doc.nodes.filter(isGroup);
    expect(groups.map((g) => g.data.label)).toEqual(["登录校验", "失败处理"]);
    const m = groupMembers(doc.nodes);
    expect(m.get(groups[0].id)!.sort()).toEqual(["n1", "n2"]);
    expect(m.get(groups[1].id)).toEqual(["n4"]);
  });

  it("旧行为回归：subgraph 不再被 DIRECTIVE_RE 整行丢弃", () => {
    // 以前这个图导入后一个框都没有
    expect(parseMermaid(SRC).nodes.some(isGroup)).toBe(true);
  });

  it("导出写回 subgraph 块，且每个节点只声明一次", () => {
    const out = toMermaid(parseMermaid(SRC));
    expect(out).toContain('subgraph g1["登录校验"]');
    expect(out).toContain('subgraph g2["失败处理"]');
    expect(out.match(/^\s*end$/gm)!).toHaveLength(2);
    // 节点声明（带包裹符的行）总共 3 个，没有重复声明
    expect(out.match(/^\s*n\d+\[/gm)!).toHaveLength(3);
  });

  it("分组用 g 前缀、节点用 n 前缀，不会混号", () => {
    const out = toMermaid(parseMermaid(SRC));
    // subgraph 后面跟的必须是 g，不能是 n
    expect(out).not.toMatch(/subgraph n\d/);
  });

  it("线型与说明在带分组时仍然保住", () => {
    const out = toMermaid(parseMermaid(SRC));
    expect(out).toMatch(/-\.->\|失败\|/);
  });

  // 回归：两个同名 subgraph 曾生成两个 id 相同的节点，React Flow 拿到重复 id 会渲染错乱。
  // parseMermaid 的契约是“任何非法内容都不抛错”，而它吃的是 AI 输出与用户粘贴，重名很现实。
  it("同名 subgraph / 与节点同名都不会造出重复 id", () => {
    const dup = parseMermaid(
      ["flowchart TD", 'subgraph g1["A"]', 'n1["x"]', "end", 'subgraph g1["B"]', 'n2["y"]', "end"].join("\n"),
    );
    const dupIds = dup.nodes.map((n) => n.id);
    expect(new Set(dupIds).size).toBe(dupIds.length);
    expect(dup.nodes.filter(isGroup)).toHaveLength(2);

    // subgraph 的 id 撞上节点 id（mermaid 里是两个命名空间，本项目里同在 doc.nodes）
    const clash = parseMermaid(
      ["flowchart TD", 'subgraph n1["A"]', 'n1["x"]', 'n2["y"]', "end"].join("\n"),
    );
    const clashIds = clash.nodes.map((n) => n.id);
    expect(new Set(clashIds).size).toBe(clashIds.length);
  });

  it("裸 subgraph（无标题）不建框也不报错", () => {
    const doc = parseMermaid(["flowchart TD", "subgraph", 'n1["x"]', "end"].join("\n"));
    expect(doc.nodes.filter(isGroup)).toHaveLength(0);
    expect(doc.nodes.map((n) => n.id)).toEqual(["n1"]);
  });

  it("空框不导出（mermaid 会画一个零尺寸空盒）", () => {
    const doc: DiagramDoc = {
      version: 1,
      nodes: [makeGroup("g", { x: 0, y: 0 }, { w: 200, h: 200 }, { label: "空的" }), node("a", 900, 900)],
      edges: [],
    };
    expect(toMermaid(doc)).not.toContain("subgraph");
  });
});

describe("区域框的序列化", () => {
  const doc: DiagramDoc = {
    version: 1,
    nodes: [
      makeGroup("g", { x: 10, y: 20 }, { w: 300, h: 200 }, { label: "分组 A", color: "#10B981" }),
      node("a", 50, 60),
    ],
    edges: [],
  };

  it("往返后 type / 位置 / 尺寸 / 标题 / 颜色都在", () => {
    const back = parseDiagram(serializeDiagram(doc));
    const g = back.nodes.find(isGroup)!;
    expect(g.position).toEqual({ x: 10, y: 20 });
    expect(g.width).toBe(300);
    expect(g.height).toBe(200);
    expect(g.data.label).toBe("分组 A");
    expect(g.data.color).toBe("#10B981");
  });

  it("zIndex / dragHandle 不入库，每次读盘重新盖上", () => {
    const raw = JSON.parse(serializeDiagram(doc));
    expect(raw.nodes[0].zIndex).toBeUndefined();
    expect(raw.nodes[0].dragHandle).toBeUndefined();
    const g = parseDiagram(serializeDiagram(doc)).nodes.find(isGroup)!;
    expect(g.zIndex).toBe(GROUP_Z);
    expect(g.dragHandle).toBe(GROUP_DRAG_HANDLE);
  });

  it("成员名单不落盘（归属是几何算的，存一份就会与位置脱节）", () => {
    const raw = JSON.parse(serializeDiagram(doc));
    expect(raw.nodes[0].members).toBeUndefined();
    expect(raw.nodes[0].data.members).toBeUndefined();
  });

  it("指向区域框的边被丢掉（框不出 Handle）", () => {
    const withBadEdge: DiagramDoc = {
      ...doc,
      edges: [{ id: "e1", source: "a", target: "g" }],
    };
    expect(parseDiagram(serializeDiagram(withBadEdge)).edges).toHaveLength(0);
  });

  it("diagramTitle 的节点计数不算区域框", () => {
    const noLabels: DiagramDoc = {
      version: 1,
      nodes: [
        makeGroup("g", { x: 0, y: 0 }, { w: 200, h: 200 }, { label: "" }),
        node("a", 0, 0, { data: { label: "" } }),
        node("b", 0, 0, { data: { label: "" } }),
      ],
      edges: [],
    };
    expect(diagramTitle(noLabels)).toBe("流程图（2 节点）");
  });
});

describe("节点尺寸与文字色的落盘", () => {
  it("缩放过的尺寸往返不丢", () => {
    const doc: DiagramDoc = { version: 1, nodes: [node("a", 0, 0, { width: 300, height: 120 })], edges: [] };
    const back = parseDiagram(serializeDiagram(doc));
    expect(back.nodes[0].width).toBe(300);
    expect(back.nodes[0].height).toBe(120);
  });

  it("没缩放过就不写尺寸（默认值入库会凭空亮未保存红点）", () => {
    const raw = JSON.parse(serializeDiagram({ version: 1, nodes: [node("a", 0, 0)], edges: [] }));
    expect(raw.nodes[0].width).toBeUndefined();
    expect(raw.nodes[0].height).toBeUndefined();
  });

  it("非法尺寸（0 / 负数 / NaN）被挡下——否则节点会渲染成一条线且拖不回来", () => {
    const bad = JSON.stringify({
      version: 1,
      nodes: [{ id: "a", position: { x: 0, y: 0 }, width: 0, height: -5, data: { label: "x" } }],
      edges: [],
    });
    const n = parseDiagram(bad).nodes[0];
    expect(n.width).toBeUndefined();
    expect(n.height).toBeUndefined();
  });

  it("textColor 往返不丢，且默认（未设）不入库", () => {
    const withColor: DiagramDoc = {
      version: 1,
      nodes: [node("a", 0, 0, { data: { label: "x", textColor: "#EF4444" } })],
      edges: [],
    };
    expect(parseDiagram(serializeDiagram(withColor)).nodes[0].data.textColor).toBe("#EF4444");
    const raw = JSON.parse(serializeDiagram({ version: 1, nodes: [node("a", 0, 0)], edges: [] }));
    expect(raw.nodes[0].data.textColor).toBeUndefined();
  });
});
