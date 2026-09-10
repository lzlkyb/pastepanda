/**
 * 设置页「定位到指定页」的护栏。
 *
 * 🔴 这条盯的是一个真开过的 bug（2026-09-09）：
 * 从知识库「⋯」菜单点「连接 AI 工具（MCP）」，设置页打开了但**停在第一节**。
 * 原因是 `useSettingsNav` 在 `initialTab` 那条路径上只 `setNav`（改左菜单高亮），
 * 而右栅的定位只由 `pendingScrollRef` 驱动——那个 ref 只在用户**手点菜单**时才被设。
 *
 * 为何断言 `scrollTo` 而不是断言 `nav`：
 * `nav` 在修复前也会瞬时变成 `"mcp"`（只是立即被 scroll-spy 抢回去），
 * 所以光看 `nav` 钉不住这个 bug。而「有没有排过一次滚动」是两边真正的分水岭。
 *
 * ⚠ jsdom 里 `offsetParent` 永远是 `null`、`getBoundingClientRect` 全返 0，
 *   所以 scroll-spy 在这里是**惰性**的——那一半的行为测不到，不装作测得到。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render } from "@testing-library/react";
import { useSettingsNav } from "@/hooks/useSettingsNav";
import type { SettingsTabName } from "@/lib/openSettings";

const scrollTo = vi.fn();

function Harness({ open, initialTab }: { open: boolean; initialTab?: SettingsTabName }) {
  const { nav, bodyRef } = useSettingsNav({
    open,
    initialTab,
    blossom: false,
    // 搜索态关掉 spy：本文件只测「有没有排滚动」，不测高亮跟随。
    searching: true,
    sectionClass: "sec",
  });
  return (
    <div ref={bodyRef} data-nav={nav}>
      {/* 顺序必须与 `SETTINGS_SECTIONS` + `SETTINGS_PAGES` 一致；
          文字必须与 `meta.ts` 里的 label **逐字一致**（`findNavEl` 是全等匹配）。 */}
      <div className="sec">数据统计</div>
      <div className="sec">MCP</div>
    </div>
  );
}

beforeEach(() => {
  scrollTo.mockClear();
  // jsdom 没实现 scrollTo，不补上会直接报错
  Element.prototype.scrollTo = scrollTo as unknown as Element["scrollTo"];
});

describe("设置页从外部跳转", () => {
  it("传 initialTab 时必须真的排一次滚动，不能只改高亮", () => {
    const { container } = render(<Harness open initialTab="mcp" />);
    expect(scrollTo).toHaveBeenCalled();
    // 高亮也要到位（这一半修复前就是对的，一并钉住防回退）
    expect(container.querySelector("[data-nav]")?.getAttribute("data-nav")).toBe("mcp");
  });

  it("不传 initialTab 时不滚——本来就在第一节，滚一下是白动一下", () => {
    render(<Harness open />);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("传 general 等同于不传（它已不再是一个页，只是旧叫法）", () => {
    render(<Harness open initialTab="general" />);
    expect(scrollTo).not.toHaveBeenCalled();
  });

  it("没打开时不动——否则设置页还没显示就已经滚过一次了", () => {
    render(<Harness open={false} initialTab="mcp" />);
    expect(scrollTo).not.toHaveBeenCalled();
  });
});
