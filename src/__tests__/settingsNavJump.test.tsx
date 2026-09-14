/**
 * 设置页「定位到指定页」的护栏。
 *
 * 🔴 第一组盯的是一个真开过的 bug（2026-09-09）：
 * 从知识库「⋯」菜单点「连接 AI 工具（MCP）」，设置页打开了但**停在第一节**。
 * 原因是 `useSettingsNav` 在 `initialTab` 那条路径上只 `setNav`（改左菜单高亮），
 * 而右栅的定位只由 `pendingScrollRef` 驱动——那个 ref 只在用户**手点菜单**时才被设。
 *
 * 为何断言 `scrollTo` 而不断言 `nav`：
 * `nav` 在修复前也会瞬时变成 `"mcp"`（只是立即被 scroll-spy 抢回去），
 * 所以光看 `nav` 钉不住这个 bug。而「有没有排过一次滚动」是两边真正的分水岭。
 *
 * 🔴 第二组盯的是另一个真 bug（2026-09-10）：同一个入口，现在会停在**「数据管理」**。
 * 上一次的修复只保证了「排一次滚动」，没保证「排得是时候」：
 * 那个 effect 依赖 `[open]`，在设置页**挂载那一刻**就算好了目标位置，
 * 而那时 `stats` 还是 null、`AiTab` 的 providers 没到、`McpTab` 压根没挂载——
 * 页面矮得多。等这些内容陆续到达把 MCP 标题往下推时，旧代码已经把 ref 清了、不再重算。
 * （手点菜单一直是好的，正因为那时候布局已经稳了。）
 *
 * ⚠ jsdom 里 `offsetParent` 永远是 `null`、`getBoundingClientRect` 全返 0，
 *   所以 scroll-spy 在这里是**惰性**的——那一半的行为测不到，不装作测得到。
 *   同理本文件也测不了「最终停在了正确像素位置」，只能测「长高后有没有重新对齐」。
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, fireEvent, act } from "@testing-library/react";
import { useSettingsNav } from "@/hooks/useSettingsNav";
import type { SettingsTabName } from "@/lib/openSettings";

/** alignTo：手点菜单走 scrollTo(smooth)，外部跳转/settling 写 scrollTop。两边都记账。 */
const scrollWrites: number[] = [];
let lastScrollTop = 0;
const scrollToMock = vi.fn((opts?: ScrollToOptions | number) => {
  const top = typeof opts === "number" ? opts : (opts?.top ?? 0);
  lastScrollTop = top;
  scrollWrites.push(top);
});

/**
 * jsdom 没有 `ResizeObserver`（`test-setup.ts` 里也没补）。
 * 装一个能**手动触发**的，用来模拟「内容长高了」这件事。
 *
 * ❗ `disconnect` 必须真的把回调摘掉：有一条用例就是验证「收手后不再对齐」，
 *   空实现的话那条会假继（回调还在数组里，一触发照样滚）。
 */
let roCallbacks: (() => void)[] = [];
class FakeResizeObserver {
  private cb: () => void;
  constructor(cb: () => void) {
    this.cb = cb;
    roCallbacks.push(cb);
  }
  observe() {}
  unobserve() {}
  disconnect() {
    roCallbacks = roCallbacks.filter((c) => c !== this.cb);
  }
}

/** 模拟异步内容到达、把目标往下推了一截。 */
function growContent() {
  act(() => {
    for (const cb of [...roCallbacks]) cb();
  });
}

function Harness({
  open,
  initialTab,
  initialSection,
  jump,
  showMcp = true,
  showLan = true,
}: {
  open: boolean;
  initialTab?: SettingsTabName;
  /** 通用页内分区 key（剪贴板同步入口用） */
  initialSection?: string;
  jump?: number;
  /** 模拟「MCP 标题那一帧还没渲染出来」 */
  showMcp?: boolean;
  showLan?: boolean;
}) {
  const { nav, bodyRef, handleNavPick } = useSettingsNav({
    open,
    initialTab,
    initialSection,
    jump,
    blossom: false,
    // 搜索态关掉 spy：本文件只测「有没有排滚动」，不测高亮跟随。
    searching: true,
    sectionClass: "sec",
  });
  return (
    <>
    {/* 真的走一遍「手点菜单」那条路，而不是拿「不传 initialTab」冒充 */}
    <button onClick={() => handleNavPick("mcp")}>手点MCP</button>
    <div ref={bodyRef} data-nav={nav}>
      {/* 顺序必须与 `SETTINGS_SECTIONS` + `SETTINGS_PAGES` 一致；
          文字必须与 `meta.ts` 里的 label **逐字一致**（`findNavEl` 是全等匹配）。 */}
      <div className="sec">数据统计</div>
      {showLan && <div className="sec">剪贴板同步</div>}
      {showMcp && <div className="sec">MCP</div>}
    </div>
    </>
  );
}

beforeEach(() => {
  scrollWrites.length = 0;
  lastScrollTop = 0;
  scrollToMock.mockClear();
  roCallbacks = [];
  // jsdom 的 Element 没有可观察的 scrollTop setter，默认也不会因赋值记账
  Object.defineProperty(Element.prototype, "scrollTop", {
    configurable: true,
    get() {
      return lastScrollTop;
    },
    set(v: number) {
      lastScrollTop = v;
      scrollWrites.push(v);
    },
  });
  Element.prototype.scrollTo = scrollToMock as unknown as Element["scrollTo"];
  vi.stubGlobal("ResizeObserver", FakeResizeObserver);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("设置页从外部跳转", () => {
  it("传 initialTab 时必须真的排一次滚动，不能只改高亮", () => {
    const { container } = render(<Harness open initialTab="mcp" />);
    expect(scrollWrites.length).toBeGreaterThan(0);
    // 高亮也要到位（这一半修复前就是对的，一并钉住防回退）
    expect(container.querySelector("[data-nav]")?.getAttribute("data-nav")).toBe("mcp");
  });

  it("不传 initialTab 时不滚——本来就在第一节，滚一下是白动一下", () => {
    render(<Harness open />);
    expect(scrollWrites.length).toBe(0);
  });

  it("传 general 等同于不传（它已不再是一个页，只是旧叫法）", () => {
    render(<Harness open initialTab="general" />);
    expect(scrollWrites.length).toBe(0);
  });

  it("section=lan 要滚到「剪贴板同步」，不能停在数据统计", () => {
    const { container } = render(
      <Harness open initialTab="general" initialSection="lan" jump={1} />,
    );
    expect(scrollWrites.length).toBeGreaterThan(0);
    expect(container.querySelector("[data-nav]")?.getAttribute("data-nav")).toBe("lan");
  });

  it("非法 section 退回第一节，不静默卡死", () => {
    const { container } = render(
      <Harness open initialTab="general" initialSection="nope" jump={1} />,
    );
    expect(scrollWrites.length).toBe(0);
    expect(container.querySelector("[data-nav]")?.getAttribute("data-nav")).toBe("stats");
  });

  it("已打开时 jump+1 要重新定位（open 本身不翻转）", () => {
    const { container, rerender } = render(<Harness open jump={1} />);
    expect(container.querySelector("[data-nav]")?.getAttribute("data-nav")).toBe("stats");

    rerender(<Harness open initialSection="lan" jump={2} />);
    expect(scrollWrites.length).toBeGreaterThan(0);
    expect(container.querySelector("[data-nav]")?.getAttribute("data-nav")).toBe("lan");
  });

  /**
   * 🔴 2026 实测 bug：scroll-spy 已把 nav 改成某一项后，用户再点同一项想对齐到顶，
   * setNav 命中 React bailout 不重渲染 → 无依赖的滚动 effect 不跑 → 页面只挪一点或不动。
   */
  it("连点同一菜单项仍要重新排滚动（setNav bailout 不能吞掉）", () => {
    const { getByText } = render(<Harness open />);
    scrollWrites.length = 0;

    fireEvent.click(getByText("手点MCP"));
    const afterFirst = scrollWrites.length;
    expect(afterFirst).toBeGreaterThan(0);

    // 再点一次（此时 nav 已是 mcp，走 bailout 路径）
    fireEvent.click(getByText("手点MCP"));
    expect(scrollWrites.length).toBeGreaterThan(afterFirst);
  });

  it("没打开时不动——否则设置页还没显示就已经滚过一次了", () => {
    render(<Harness open={false} initialTab="mcp" />);
    expect(scrollWrites.length).toBe(0);
  });
});

describe("跳转后的校正窗口（目标会被后到的内容往下推）", () => {
  it("内容长高后要重新对齐，不能是一锤子买卖", () => {
    render(<Harness open initialTab="mcp" />);
    const first = scrollWrites.length;
    expect(first).toBeGreaterThan(0);

    // stats / AiTab / McpTab 陆续到达，把 MCP 标题往下推
    growContent();

    expect(scrollWrites.length).toBeGreaterThan(first);
  });

  it("手点菜单不进校正窗口——那时布局已稳，再插手只会打断定位", () => {
    const { getByText } = render(<Harness open />);
    expect(scrollWrites.length).toBe(0);

    fireEvent.click(getByText("手点MCP"));

    // 滑是要滑的……
    expect(scrollWrites.length).toBeGreaterThan(0);
    // ……但不该建校正窗口
    expect(roCallbacks.length).toBe(0);
  });

  it("校正窗口里用户自己滚了就收手，不跟他抢滚动条", () => {
    const { container } = render(<Harness open initialTab="mcp" />);
    const scroller = container.querySelector("[data-nav]") as HTMLElement;

    fireEvent.wheel(scroller);
    const afterWheel = scrollWrites.length;

    // 收手之后内容再长高也不应该再把用户拉回去
    growContent();

    expect(scrollWrites.length).toBe(afterWheel);
  });

  it("目标那一帧还没渲染出来时，跳转不能丢——下次渲染要重试", () => {
    // 🔴 这条盯的是 `pendingScrollRef` 的清空时机：旧代码在取 target **之前**
    //    就把 ref 置 null 了，于是「那一帧恰好没找到」等于永久放弃。
    //    MCP 真实场景下标题一直在 DOM 里，所以没暴露——属于侥幸。
    const { rerender } = render(<Harness open initialTab="mcp" showMcp={false} />);
    expect(scrollWrites.length).toBe(0);

    rerender(<Harness open initialTab="mcp" showMcp />);
    expect(scrollWrites.length).toBeGreaterThan(0);
  });
});
