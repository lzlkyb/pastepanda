/**
 * 流程图核心逻辑测试（@/lib/diagram/types + @/lib/diagram/aiGenerate）。
 *
 * 覆盖：安全解析 / 序列化往返 / Mermaid 导出 / dagre 自动布局 / elk 大图布局 /
 * 标题与标签拼接 / 唯一 id；以及 mermaid 容错解析（导入 / AI 生成共用）。
 */
import { describe, it, expect } from "vitest";

import {
  emptyDoc,
  parseDiagram,
  serializeDiagram,
  nodeLabelsText,
  diagramTitle,
  toMermaid,
  autoLayout,
  autoLayoutElk,
  parseMermaid,
  extractMermaid,
  newId,
  asShape,
  pickEdgeHandles,
  routeAutoEdges,
  type DiagramDoc,
  type DNode,
} from "@/lib/diagram/types";

describe("emptyDoc", () => {
  it("返回空文档且 version=1", () => {
    const d = emptyDoc();
    expect(d.version).toBe(1);
    expect(d.nodes).toEqual([]);
    expect(d.edges).toEqual([]);
  });
});

describe("parseDiagram（安全解析）", () => {
  it("undefined / null / 空串 → 空文档（绝不抛错）", () => {
    expect(parseDiagram(undefined).nodes).toEqual([]);
    expect(parseDiagram(null).nodes).toEqual([]);
    expect(parseDiagram("").nodes).toEqual([]);
  });

  it("非法 JSON → 空文档（绝不抛错）", () => {
    const d = parseDiagram("{ not valid json");
    expect(d.nodes).toEqual([]);
    expect(d.edges).toEqual([]);
  });

  it("缺 nodes/edges 字段 → 空文档", () => {
    expect(parseDiagram(JSON.stringify({ foo: 1 })).nodes).toEqual([]);
  });

  it("解析合法文档：节点带默认 shape=rect、type=diagram", () => {
    const content = JSON.stringify({
      version: 1,
      nodes: [{ id: "a", position: { x: 1, y: 2 }, data: { label: "开始", shape: "round" } }],
      edges: [{ id: "e1", source: "a", target: "a", label: "自环" }],
    });
    const d = parseDiagram(content);
    expect(d.nodes).toHaveLength(1);
    expect(d.nodes[0].type).toBe("diagram");
    expect(d.nodes[0].data.label).toBe("开始");
    expect(d.nodes[0].data.shape).toBe("round");
    expect(d.edges).toHaveLength(1);
    expect(d.edges[0].label).toBe("自环");
  });

  it("丢弃指向不存在端点的边（数据自修复）", () => {
    const content = JSON.stringify({
      nodes: [{ id: "a", data: { label: "A" } }],
      edges: [{ source: "a", target: "ghost" }, { source: "a", target: "a" }],
    });
    const d = parseDiagram(content);
    expect(d.edges).toHaveLength(1);
    expect(d.edges[0].target).toBe("a");
  });
});

describe("serializeDiagram（往返一致）", () => {
  it("序列化后再解析得到等价文档", () => {
    const doc: DiagramDoc = {
      version: 1,
      nodes: [
        { id: "a", type: "diagram", position: { x: 10, y: 20 }, data: { label: "A", color: "#f00", shape: "ellipse" } },
        { id: "b", type: "diagram", position: { x: 30, y: 40 }, data: { label: "B" } },
      ],
      edges: [{ id: "e1", source: "a", target: "b", label: "go", type: "smoothstep" }],
    };
    const round = parseDiagram(serializeDiagram(doc));
    expect(round.nodes).toHaveLength(2);
    expect(round.nodes[0].data.color).toBe("#f00");
    expect(round.nodes[1].data.shape).toBe("rect"); // 缺省 rect
    expect(round.edges).toHaveLength(1);
    expect(round.edges[0].label).toBe("go");
  });
});

describe("nodeLabelsText / diagramTitle", () => {
  it("标签用 ' / ' 拼接", () => {
    const doc = parseDiagram(
      JSON.stringify({ nodes: [{ id: "a", data: { label: "登录" } }, { id: "b", data: { label: "首页" } }] }),
    );
    expect(nodeLabelsText(doc)).toBe("登录 / 首页");
  });

  it("无标签时标题为「流程图（N 节点）」", () => {
    const doc = parseDiagram(JSON.stringify({ nodes: [{ id: "a", data: {} }, { id: "b", data: {} }] }));
    expect(diagramTitle(doc)).toBe("流程图（2 节点）");
  });

  it("有标签时标题取标签拼接", () => {
    const doc = parseDiagram(JSON.stringify({ nodes: [{ id: "a", data: { label: "登录" } }] }));
    expect(diagramTitle(doc)).toBe("登录");
  });
});

describe("toMermaid（导出）", () => {
  it("输出 flowchart TD 且包裹不同形状", () => {
    const doc: DiagramDoc = {
      version: 1,
      nodes: [
        { id: "a", type: "diagram", position: { x: 0, y: 0 }, data: { label: "开始", shape: "rect" } },
        { id: "b", type: "diagram", position: { x: 0, y: 0 }, data: { label: "处理", shape: "round" } },
        { id: "c", type: "diagram", position: { x: 0, y: 0 }, data: { label: "判断", shape: "diamond" } },
      ],
      edges: [
        { id: "e1", source: "a", target: "b" },
        { id: "e2", source: "b", target: "c", label: "条件" },
      ],
    };
    const m = toMermaid(doc);
    expect(m.startsWith("flowchart TD")).toBe(true);
    expect(m).toContain('n1["开始"]');
    expect(m).toContain('n2("处理")');
    expect(m).toContain('n3{"判断"}');
    expect(m).toContain("n1 --> n2");
    expect(m).toContain("n2 -->|条件| n3");
  });

  it("标签内含双引号会转义", () => {
    const doc: DiagramDoc = {
      version: 1,
      nodes: [{ id: "a", type: "diagram", position: { x: 0, y: 0 }, data: { label: '说"hi"' } }],
      edges: [],
    };
    expect(toMermaid(doc)).toContain('n1["说\\"hi\\""]');
  });
});

describe("autoLayout（dagre 布局）", () => {
  it("保留节点数并为每个节点算出新位置（有限数）", () => {
    const doc: DiagramDoc = {
      version: 1,
      nodes: [
        { id: "a", type: "diagram", position: { x: 0, y: 0 }, data: { label: "A" } },
        { id: "b", type: "diagram", position: { x: 0, y: 0 }, data: { label: "B" } },
        { id: "c", type: "diagram", position: { x: 0, y: 0 }, data: { label: "C" } },
      ],
      edges: [
        { id: "e1", source: "a", target: "b" },
        { id: "e2", source: "b", target: "c" },
      ],
    };
    const laid = autoLayout(doc);
    expect(laid.nodes).toHaveLength(3);
    for (const n of laid.nodes) {
      expect(Number.isFinite(n.position.x)).toBe(true);
      expect(Number.isFinite(n.position.y)).toBe(true);
    }
  });
});

describe("newId", () => {
  it("连续调用返回不同 id", () => {
    const a = newId();
    const b = newId();
    expect(a).not.toBe(b);
  });
});

describe("extractMermaid", () => {
  it("从 ```mermaid 围栏中抽取", () => {
    const text = "说明文字\n```mermaid\nflowchart TD\nA --> B\n```\n结尾";
    expect(extractMermaid(text)).toBe("flowchart TD\nA --> B");
  });

  it("无围栏时截取首个 flowchart 起到结尾", () => {
    const text = "这是需求：\nflowchart TD\nA --> B";
    expect(extractMermaid(text)).toBe("flowchart TD\nA --> B");
  });
});

describe("parseMermaid（AI 返回容错解析）", () => {
  it("解析带标签声明的节点 + 无标签边", () => {
    const src = "flowchart TD\nA[开始]\nB[结束]\nA --> B";
    const doc = parseMermaid(src);
    expect(doc.nodes).toHaveLength(2);
    expect(doc.edges).toHaveLength(1);
    expect(doc.edges[0].source).toBe("A");
    expect(doc.edges[0].target).toBe("B");
    const a = doc.nodes.find((n) => n.id === "A");
    expect(a?.data.label).toBe("开始");
    expect(a?.data.shape).toBe("rect");
  });

  it("识别菱形 / 圆角形状", () => {
    const doc = parseMermaid("flowchart TD\nC{判断}\nD(步骤)");
    const c = doc.nodes.find((n) => n.id === "C");
    const d = doc.nodes.find((n) => n.id === "D");
    expect(c?.data.shape).toBe("diamond");
    expect(d?.data.shape).toBe("round");
  });

  it("边里出现的孤立节点也会补建成空标签节点", () => {
    const doc = parseMermaid("flowchart TD\nA --> B");
    expect(doc.nodes.map((n) => n.id).sort()).toEqual(["A", "B"]);
  });

  it("带说明的连线解析出 edge.label", () => {
    const doc = parseMermaid("flowchart TD\nA -->|成功| B");
    expect(doc.edges).toHaveLength(1);
    expect(doc.edges[0].label).toBe("成功");
  });

  it("解析后经过自动布局，节点都有有限坐标", () => {
    const doc = parseMermaid("flowchart TD\nA[开始]\nB[结束]\nA --> B");
    for (const n of doc.nodes) {
      expect(Number.isFinite(n.position.x)).toBe(true);
      expect(Number.isFinite(n.position.y)).toBe(true);
    }
  });

  // 回归：旧实现用两条整行锚定的正则，「声明+连线写在同一行」会被整行丢弃，
  // 而这正是导入框 placeholder、AI 提示词、以及 Mermaid 官方文档的主流写法。
  it("同一行写「节点声明 + 连线」也能完整解析", () => {
    const doc = parseMermaid("flowchart TD\n  A[开始] --> B[处理]");
    expect(doc.nodes.map((n) => n.id)).toEqual(["A", "B"]);
    expect(doc.nodes.find((n) => n.id === "A")?.data.label).toBe("开始");
    expect(doc.nodes.find((n) => n.id === "B")?.data.label).toBe("处理");
    expect(doc.edges).toHaveLength(1);
    expect(doc.edges[0]).toMatchObject({ source: "A", target: "B" });
  });

  it("导入框 placeholder 的完整例子：4 节点均有标签与形状，4 条连线", () => {
    const doc = parseMermaid(
      "flowchart TD\n  A[开始] --> B[处理]\n  B --> C{判断?}\n  C -->|是| D[完成]\n  C -->|否| B",
    );
    expect(doc.nodes.map((n) => n.id).sort()).toEqual(["A", "B", "C", "D"]);
    expect(doc.nodes.every((n) => n.data.label !== "")).toBe(true);
    expect(doc.nodes.find((n) => n.id === "C")?.data.shape).toBe("diamond");
    expect(doc.nodes.find((n) => n.id === "D")?.data.label).toBe("完成");
    expect(doc.edges).toHaveLength(4);
    expect(doc.edges.filter((e) => e.label === "是")).toHaveLength(1);
  });

  it("链式写法 A --> B --> C 拆成两条边", () => {
    const doc = parseMermaid("flowchart TD\nA[一] --> B[二] --> C[三]");
    expect(doc.nodes).toHaveLength(3);
    expect(doc.edges).toHaveLength(2);
  });

  it("先裸 id 后带标签声明，标签能补写进先建的空节点", () => {
    const doc = parseMermaid("flowchart TD\nA --> B\nB[后补的标签]");
    expect(doc.nodes.find((n) => n.id === "B")?.data.label).toBe("后补的标签");
  });

  it("标签不会带出包裹符残渣（旧实现 {判断} 会解出带花括号的标签）", () => {
    const doc = parseMermaid("flowchart TD\nC{判断}\nD(步骤)\nE([起止])\nF((圆))");
    const label = (id: string) => doc.nodes.find((n) => n.id === id)?.data.label;
    const shape = (id: string) => doc.nodes.find((n) => n.id === id)?.data.shape;
    expect(label("C")).toBe("判断");
    expect(label("D")).toBe("步骤");
    expect(label("E")).toBe("起止");
    expect(label("F")).toBe("圆");
    expect(shape("C")).toBe("diamond");
    expect(shape("D")).toBe("round");
    expect(shape("E")).toBe("pill");
    expect(shape("F")).toBe("ellipse");
  });

  it("跳过注释与子图 / 样式声明行，不会把它们当成节点", () => {
    const doc = parseMermaid(
      "flowchart TD\n%% 这是注释\nsubgraph 分组\nA[一] --> B[二]\nend\nstyle A fill:#f00",
    );
    expect(doc.nodes.map((n) => n.id).sort()).toEqual(["A", "B"]);
  });
});

// 回归：旧版 shapeAndLabel 的剥壳正则对除「无引号方括号」外的所有形状都是错的，
// 导致「复制 Mermaid 源码 → 再导入」拿到带引号 / 带括号的标签。
describe("toMermaid ↔ parseMermaid 往返", () => {
  // 形状集故意对齐 Mermaid 的形状词汇，就是为了这条：每一种都能往返。
  // text 除外——mermaid 没有对应形状，退化成 rect（单独一条用例盯）。
  it("十种形状的标签与形状往返后保持不变", () => {
    const shapes = [
      "rect", "round", "pill", "ellipse", "diamond",
      "hexagon", "parallelogram", "trapezoid", "cylinder", "subroutine",
    ] as const;
    const doc: DiagramDoc = {
      version: 1,
      nodes: shapes.map((shape, i) => ({
        id: `n${i}`,
        type: "diagram",
        position: { x: 0, y: 0 },
        data: { label: `节点${i}`, shape },
      })),
      edges: [{ id: "e1", source: "n0", target: "n1", label: "下一步" }],
    };
    const back = parseMermaid(toMermaid(doc));
    expect(back.nodes.map((n) => n.data.shape)).toEqual([...shapes]);
    expect(back.nodes.map((n) => n.data.label)).toEqual(shapes.map((_, i) => `节点${i}`));
    expect(back.edges).toHaveLength(1);
    expect(back.edges[0].label).toBe("下一步");
  });

  it("text 形状 mermaid 表达不了，往返后退化成 rect（固有取舍）", () => {
    const doc: DiagramDoc = {
      version: 1,
      nodes: [{ id: "a", type: "diagram", position: { x: 0, y: 0 }, data: { label: "注释", shape: "text" } }],
      edges: [],
    };
    const back = parseMermaid(toMermaid(doc));
    expect(back.nodes[0].data.label).toBe("注释");
    expect(back.nodes[0].data.shape).toBe("rect");
  });

  it("asShape 把未知形状收敛成 rect（否则 className 里会出现 undefined）", () => {
    expect(asShape("hexagon")).toBe("hexagon");
    expect(asShape("不存在的形状")).toBe("rect");
    expect(asShape(undefined)).toBe("rect");
    expect(asShape(42)).toBe("rect");
    // 旧文档里的 ellipse 必须仍然有效（没改名成 circle 就是为了这个）
    expect(asShape("ellipse")).toBe("ellipse");
  });

  it("标签内含双引号也能原样往返", () => {
    const doc: DiagramDoc = {
      version: 1,
      nodes: [{ id: "a", type: "diagram", position: { x: 0, y: 0 }, data: { label: '说"hi"' } }],
      edges: [],
    };
    expect(parseMermaid(toMermaid(doc)).nodes[0].data.label).toBe('说"hi"');
  });
});

// 回归：这一条是真实踩到的——AI 生成的图结构完全正确，但每条边都没锚点，
// React Flow 对裸边取 handles[0]（= DiagramNode 第一个声明的 top），
// 于是全部画成 top→top，在自上而下的布局里看着就是“节点没对上”。
// 旧测试只验 source/target 对不对，验不出这一类问题。
describe("生成类连线的默认锚点", () => {
  it("parseMermaid 产出的边带 bottom → top，不能是裸边", () => {
    const doc = parseMermaid("flowchart TD\nA[开始] --> B[处理]\nB --> C{判断}");
    expect(doc.edges).toHaveLength(2);
    for (const e of doc.edges) {
      expect(e.sourceHandle).toBe("bottom");
      expect(e.targetHandle).toBe("top");
    }
  });

  // 回边（目标在上方）不能再用 bottom→top：那会从源节点底部出发、继续向下、
  // 再绕一大圈爬回目标顶部，压过中间的节点——实测里“线很乱”就是这么来的。
  it("回边走同侧锚点，不走 bottom→top", () => {
    const doc = parseMermaid(
      "flowchart TD\nA[开始] --> B[登录]\nB --> C{成功?}\nC -->|否| E[提示错误]\nE --> B\nC -->|是| D[首页]",
    );
    const back = doc.edges.find((e) => e.source === "E" && e.target === "B");
    expect(back).toBeDefined();
    expect(back!.sourceHandle).toBe(back!.targetHandle); // 同侧进出
    expect(["left", "right"]).toContain(back!.sourceHandle);

    // 下行的主干边不受影响
    const fwd = doc.edges.find((e) => e.source === "A" && e.target === "B");
    expect(fwd!.sourceHandle).toBe("bottom");
    expect(fwd!.targetHandle).toBe("top");
  });

  it("pickEdgeHandles 三条规则", () => {
    const at = (id: string, x: number, y: number): DNode => ({
      id, type: "diagram", position: { x, y }, data: { label: id },
    });
    // 目标在下方 → 主干
    expect(pickEdgeHandles(at("a", 0, 0), at("b", 0, 200))).toEqual({
      sourceHandle: "bottom", targetHandle: "top",
    });
    // 回边且源在目标左边 → 走左侧
    expect(pickEdgeHandles(at("a", 0, 200), at("b", 300, 0))).toEqual({
      sourceHandle: "left", targetHandle: "left",
    });
    // 回边且源在目标右边 → 走右侧
    expect(pickEdgeHandles(at("a", 300, 200), at("b", 0, 0))).toEqual({
      sourceHandle: "right", targetHandle: "right",
    });
    // 大致平齐 → 横向
    expect(pickEdgeHandles(at("a", 0, 0), at("b", 300, 10))).toEqual({
      sourceHandle: "right", targetHandle: "left",
    });
  });

  it("手绘边（无 autoRoute 标记）不被 routeAutoEdges 动", () => {
    const nodes: DNode[] = [
      { id: "a", type: "diagram", position: { x: 0, y: 0 }, data: { label: "A" } },
      { id: "b", type: "diagram", position: { x: 0, y: 300 }, data: { label: "B" } },
    ];
    const manual = { id: "e1", source: "a", target: "b", sourceHandle: "right", targetHandle: "right" };
    const auto = { id: "e2", source: "a", target: "b", sourceHandle: "right", targetHandle: "right", data: { autoRoute: true } };
    const [m, a] = routeAutoEdges(nodes, [manual, auto]);
    expect(m.sourceHandle).toBe("right"); // 手绘的原样保留
    expect(a.sourceHandle).toBe("bottom"); // 自动的被重算
    expect(a.targetHandle).toBe("top");
  });

  it("autoRoute 标记能序列化往返，否则重开后分不清手绘还是自动", () => {
    const doc = parseMermaid("flowchart TD\nA[一] --> B[二]");
    const back = parseDiagram(serializeDiagram(doc));
    expect(back.edges[0].data?.autoRoute).toBe(true);
  });

  it("parseDiagram 读到没锚点的旧文档时按位置重算", () => {
    const legacy = JSON.stringify({
      version: 1,
      nodes: [
        { id: "a", position: { x: 0, y: 0 }, data: { label: "A" } },
        { id: "b", position: { x: 0, y: 300 }, data: { label: "B" } }, // b 在 a 下方
      ],
      edges: [{ id: "e1", source: "a", target: "b" }], // 旧数据：没有 handle 字段
    });
    const doc = parseDiagram(legacy);
    expect(doc.edges[0].data?.autoRoute).toBe(true); // 裸边一律当自动边
    expect(doc.edges[0].sourceHandle).toBe("bottom");
    expect(doc.edges[0].targetHandle).toBe("top");
  });

  it("已存的手绘锚点不会被默认值覆盖", () => {
    const manual = JSON.stringify({
      version: 1,
      nodes: [{ id: "a", data: { label: "A" } }, { id: "b", data: { label: "B" } }],
      edges: [{ id: "e1", source: "a", target: "b", sourceHandle: "right", targetHandle: "left" }],
    });
    const doc = parseDiagram(manual);
    expect(doc.edges[0].sourceHandle).toBe("right");
    expect(doc.edges[0].targetHandle).toBe("left");
  });
});

describe("连线锚点（sourceHandle / targetHandle）落盘", () => {
  it("序列化往返保留锚点，否则重开后连线走向会变", () => {
    const doc: DiagramDoc = {
      version: 1,
      nodes: [
        { id: "a", type: "diagram", position: { x: 0, y: 0 }, data: { label: "A" } },
        { id: "b", type: "diagram", position: { x: 0, y: 0 }, data: { label: "B" } },
      ],
      edges: [{ id: "e1", source: "a", target: "b", sourceHandle: "right", targetHandle: "left" }],
    };
    const back = parseDiagram(serializeDiagram(doc));
    expect(back.edges[0].sourceHandle).toBe("right");
    expect(back.edges[0].targetHandle).toBe("left");
  });
});

describe("autoLayoutElk（elkjs 大图布局）", () => {
  it("异步返回新位置且全部有限（中等规模图）", async () => {
    const doc: DiagramDoc = {
      version: 1,
      nodes: Array.from({ length: 40 }, (_, i) => ({
        id: `n${i}`,
        type: "diagram",
        position: { x: 0, y: 0 },
        data: { label: `节点${i}` },
      })),
      edges: Array.from({ length: 39 }, (_, i) => ({
        id: `e${i}`,
        source: `n${i}`,
        target: `n${i + 1}`,
      })),
    };
    const laid = await autoLayoutElk(doc);
    expect(laid.nodes).toHaveLength(40);
    for (const n of laid.nodes) {
      expect(Number.isFinite(n.position.x)).toBe(true);
      expect(Number.isFinite(n.position.y)).toBe(true);
    }
  });

  it("解析 mermaid 后可用 elk 重新布局，节点数不变", async () => {
    const doc = parseMermaid(
      "flowchart TD\nA[开始]\nB[处理]\nC{判断?}\nA --> B\nB --> C\nC -->|是| D[完成]\nC -->|否| B",
    );
    const laid = await autoLayoutElk(doc);
    expect(laid.nodes).toHaveLength(4);
    expect(laid.edges).toHaveLength(4);
  });
});
