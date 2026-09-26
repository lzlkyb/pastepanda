/**
 * 多标签纯逻辑守卫单测。
 *
 * 为什么这些规则值得单独钉住：它们的失败形态都是**静默的数据问题**，
 * 而不是界面上看得见的错——
 *   - 去重键漏折叠大小写 → 同一文件开成两个标签，各持一份文本，谁后保存谁覆盖；
 *   - 关活动标签后焦点落错 → Ctrl+W 连按会跳到列表头部，用户丢失去向；
 *   - 上限判定写反 → 第 13 个静默挤掉别人。
 * 组件层测试抓不到这些（它们根本不涉及渲染）。
 */
import { describe, it, expect } from "vitest";
import {
  MAX_EDITOR_TABS,
  canOpenMore,
  dedupeKeyOf,
  findTabIndex,
  nextActiveAfterClose,
  normalizeEditorPath,
  tabLimitMessage,
} from "@/lib/editorTabs";

describe("normalizeEditorPath", () => {
  it("统一分隔符 / 去尾斜杠 / 折叠大小写", () => {
    expect(normalizeEditorPath("D:\\Docs\\周报.MD")).toBe("d:/docs/周报.md");
    expect(normalizeEditorPath("d:/docs/")).toBe("d:/docs");
    expect(normalizeEditorPath("D:\\Docs")).toBe(normalizeEditorPath("d:/docs"));
  });
});

describe("dedupeKeyOf", () => {
  it("filePath 优先于 sourceId（另存为之后身份变成文件）", () => {
    const key = dedupeKeyOf({ filePath: "D:\\a\\b.md", sourceId: "h1" });
    expect(key).toBe("f:d:/a/b.md");
  });

  it("两种路径形态折叠成同一个键 —— 同一文件不会开成两个标签", () => {
    const a = dedupeKeyOf({ filePath: "D:\\Docs\\周报.md" });
    const b = dedupeKeyOf({ filePath: "d:/docs/周报.md" });
    expect(a).toBe(b);
  });

  it("只有 sourceId 时按卡片身份去重", () => {
    expect(dedupeKeyOf({ sourceId: "abc" })).toBe("s:abc");
  });

  it("既无文件也无来源 → null（每次打开都该是新标签）", () => {
    expect(dedupeKeyOf({ content: "自由文本" })).toBeNull();
    expect(dedupeKeyOf({ content: "", sourceId: null, filePath: null })).toBeNull();
  });
});

describe("findTabIndex", () => {
  it("命中返回下标；无身份恒 -1（不能拿 null 去 indexOf）", () => {
    const keys = ["f:a", null, "s:b"];
    expect(findTabIndex(keys, "s:b")).toBe(2);
    expect(findTabIndex(keys, "f:zzz")).toBe(-1);
    expect(findTabIndex(keys, null)).toBe(-1);
  });
});

describe("canOpenMore", () => {
  it("边界：12 上限，第 13 个被拒", () => {
    expect(MAX_EDITOR_TABS).toBe(12);
    expect(canOpenMore(11)).toBe(true);
    expect(canOpenMore(12)).toBe(false);
    expect(canOpenMore(0)).toBe(true);
  });
});

describe("nextActiveAfterClose", () => {
  const order = ["a", "b", "c", "d"];

  it("关的不是活动标签 → 活动标签不动（别挪走用户视线）", () => {
    expect(nextActiveAfterClose(order, "c", "a")).toBe("c");
  });

  it("关的是活动标签 → 接管它原来的右邻", () => {
    expect(nextActiveAfterClose(order, "b", "b")).toBe("c");
  });

  it("关的是最后一个活动标签 → 取新的最后一个（左邻）", () => {
    expect(nextActiveAfterClose(order, "d", "d")).toBe("c");
  });

  it("全部关完 → null（宿主据此关窗）", () => {
    expect(nextActiveAfterClose(["a"], "a", "a")).toBeNull();
  });

  it("closedId 不在列表里 → 返回原活动标签（并发关闭等边界不能乱跳）", () => {
    expect(nextActiveAfterClose(order, "b", "zz")).toBe("b");
  });
});

/**
 * 上限提示文案的守卫。
 *
 * 钉住它是因为「上限被拒」曾经是**静默**的：三条打开路径里只有两条会提示，
 * 建窗期队列那条一次多选超过 12 个文件时凭空吞掉多出来的几个。文案本身
 * 收口成单一来源之后，任何一个新调用点少接一次提示，这里就会红。
 */
describe("tabLimitMessage", () => {
  it("单次打开被拒：只报上限，不报个数", () => {
    expect(tabLimitMessage()).toBe(`最多同时打开 ${MAX_EDITOR_TABS} 个文档`);
  });

  it("批量打开被拒：带上被拒个数", () => {
    expect(tabLimitMessage(3)).toBe(`最多同时打开 ${MAX_EDITOR_TABS} 个文档，另有 3 个未能打开`);
  });

  it("rejected=0 退化成单次文案（不能出现「另有 0 个未能打开」）", () => {
    expect(tabLimitMessage(0)).toBe(tabLimitMessage());
  });
});
