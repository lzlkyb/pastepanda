/**
 * 第 2 批工作台化新增交互件的守卫：DropdownMenu / MarkdownFormatBar / NoteViewModeSwitch。
 *
 * 防的回归（与 fullscreenShell.test.tsx 同思路）：
 * - P0-5 收束时**静默丢操作**：原 14 个格式操作必须一个不少（4 直达 + 4 菜单全覆盖）；
 * - 菜单浮层类（menuPop 等）没人引用 —— styles.X 指向不存在的类只得 undefined，
 *   tsc 与运行时都不报错，只有子串匹配能证明「这个类真的被用上了」；
 * - NoteViewModeSwitch 的常驻文字来自 TRI_MODES（规则 #11 单一数据源），
 *   断言它真的渲染了 label —— 防止哪天改回裸图标。
 *
 * 类名断言用子串匹配（jsdom 下 CSS Modules 类名是 `_xxx_hash`，见 fullscreenShell.test.tsx 头注）。
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, cleanup, fireEvent } from "@testing-library/react";
import { MarkdownFormatBar } from "@/components/editors/fullscreen/MarkdownFormatBar";
import { NoteViewModeSwitch } from "@/components/notes/NoteViewModeSwitch";
import type { ShellBridge } from "@/components/editors/fullscreen/types";

afterEach(cleanup);

const sel = (cls: string) => `[class*="${cls}"]`;
const q = (root: Element, cls: string) => root.querySelector(sel(cls));
const qa = (root: Element, cls: string) => root.querySelectorAll(sel(cls));
const hasCls = (el: Element, cls: string) => new RegExp(`_${cls}_\\w+`).test(el.className);

function makeBridge(): ShellBridge {
  return {
    text: "",
    replaceDoc: vi.fn(),
    gotoLine: vi.fn(),
    insertFormat: vi.fn(),
    insertLinePrefix: vi.fn(),
    toggleComment: vi.fn(),
    indentMore: vi.fn(),
    indentLess: vi.fn(),
    openSearch: vi.fn(),
  };
}

describe("MarkdownFormatBar（P0-5 收束版）", () => {
  it("直达区：查找 + 粗体/斜体/删除线/行内码，各回调到 bridge", () => {
    const bridge = makeBridge();
    render(<MarkdownFormatBar bridge={bridge} />);

    fireEvent.click(screen.getByTitle("查找 Ctrl+F"));
    expect(bridge.openSearch).toHaveBeenCalled();

    fireEvent.click(screen.getByTitle("粗体 Ctrl+B"));
    expect(bridge.insertFormat).toHaveBeenLastCalledWith("**", "**");

    fireEvent.click(screen.getByTitle("斜体 Ctrl+I"));
    expect(bridge.insertFormat).toHaveBeenLastCalledWith("*", "*");

    fireEvent.click(screen.getByTitle("删除线"));
    expect(bridge.insertFormat).toHaveBeenLastCalledWith("~~", "~~");

    fireEvent.click(screen.getByTitle("行内代码"));
    expect(bridge.insertFormat).toHaveBeenLastCalledWith("`", "`");
  });

  it("4 个带文字菜单触发器齐全，直达裸图标已不再常驻（标题/引用/表格不是直接按钮）", () => {
    const bridge = makeBridge();
    const { container } = render(<MarkdownFormatBar bridge={bridge} />);

    for (const label of ["标题", "列表", "引用与代码块", "插入"]) {
      expect(screen.getByTitle(label)).toBeTruthy();
    }
    // 菜单未打开时，收纳项不出现在 DOM（打开后由下一条断言覆盖）
    expect(screen.queryByText("无序列表")).toBeNull();
    // 触发器用 fmtMenuBtn 类（不是裸 fmtBtn）
    expect(qa(container, "fmtMenuBtn").length).toBe(4);
    // 裸图标直达只剩 4 个字形按钮（原 14 个中的 B/I/S/行内码）。
    // ⚠️ 不能数 qa("fmtBtn")：fmtBtnText（查找）也含该子串，子串匹配会多算。
    const fmtBtns = Array.from(qa(container, "fmtBtn")).filter((el) => hasCls(el, "fmtBtn"));
    expect(fmtBtns.length).toBe(4);
  });

  it("菜单展开后 14 个原操作一个不少，选中即回调并收起", () => {
    const bridge = makeBridge();
    const { container } = render(<MarkdownFormatBar bridge={bridge} />);

    // 标题 H1-H3
    fireEvent.click(screen.getByTitle("标题"));
    expect(screen.getByText("标题 1")).toBeTruthy();
    expect(screen.getByText("标题 2")).toBeTruthy();
    expect(screen.getByText("标题 3")).toBeTruthy();
    fireEvent.click(screen.getByText("标题 2"));
    expect(bridge.insertLinePrefix).toHaveBeenLastCalledWith("## ");
    expect(q(container, "menuPop")).toBeNull();

    // 列表：无序/有序/任务
    fireEvent.click(screen.getByTitle("列表"));
    fireEvent.click(screen.getByText("无序列表"));
    expect(bridge.insertLinePrefix).toHaveBeenLastCalledWith("- ");
    fireEvent.click(screen.getByTitle("列表"));
    fireEvent.click(screen.getByText("有序列表"));
    expect(bridge.insertLinePrefix).toHaveBeenLastCalledWith("1. ");
    fireEvent.click(screen.getByTitle("列表"));
    fireEvent.click(screen.getByText("任务列表"));
    expect(bridge.insertLinePrefix).toHaveBeenLastCalledWith("- [ ] ");

    // 引用与代码块
    fireEvent.click(screen.getByTitle("引用与代码块"));
    fireEvent.click(screen.getByText("引用"));
    expect(bridge.insertLinePrefix).toHaveBeenLastCalledWith("> ");
    fireEvent.click(screen.getByTitle("引用与代码块"));
    fireEvent.click(screen.getByText("代码块"));
    expect(bridge.insertFormat).toHaveBeenLastCalledWith("\n```\n", "\n```\n");

    // 插入：链接/图片/表格/分隔线
    fireEvent.click(screen.getByTitle("插入"));
    fireEvent.click(screen.getByText("链接"));
    expect(bridge.insertFormat).toHaveBeenLastCalledWith("[", "](url)");
    fireEvent.click(screen.getByTitle("插入"));
    fireEvent.click(screen.getByText("图片"));
    expect(bridge.insertFormat).toHaveBeenLastCalledWith("![alt](", ")");
    fireEvent.click(screen.getByTitle("插入"));
    fireEvent.click(screen.getByText("表格"));
    expect(bridge.insertFormat).toHaveBeenLastCalledWith("\n| 列1 | 列2 |\n| --- | --- |\n| ", " |  |\n");
    fireEvent.click(screen.getByTitle("插入"));
    fireEvent.click(screen.getByText("分隔线"));
    expect(bridge.insertFormat).toHaveBeenLastCalledWith("\n---\n");
  });

  it("菜单条目渲染 kbd 常驻提示（L5），浮层卡真的用了 menuPop 类", () => {
    const bridge = makeBridge();
    const { container } = render(<MarkdownFormatBar bridge={bridge} />);

    fireEvent.click(screen.getByTitle("插入"));
    expect(q(container, "menuPop")).toBeTruthy();
    expect(q(container, "menuItemKbd")!.textContent).toBe("[]()");
  });
});

describe("NoteViewModeSwitch（P0-1 连带：图标 + 常驻文字）", () => {
  it("三个按钮渲染 TRI_MODES 的常驻文字（编辑/分屏/预览），当前项带 on 且 aria-pressed", () => {
    const onChange = vi.fn();
    const { container } = render(<NoteViewModeSwitch value="preview" onChange={onChange} />);

    const btns = Array.from(qa(container, "btn"));
    expect(btns.length).toBe(3);
    expect(btns.map((b) => b.textContent)).toEqual(["编辑", "分屏", "预览"]);
    expect(hasCls(btns[2], "on")).toBe(true);
    expect(btns[2].getAttribute("aria-pressed")).toBe("true");
    expect(btns[0].getAttribute("aria-pressed")).toBe("false");

    fireEvent.click(btns[0]);
    expect(onChange).toHaveBeenCalledWith("edit");
  });

  it("splitDisabled 时分屏置灰但保留位置（tooltip 说明原因）", () => {
    const onChange = vi.fn();
    const { container } = render(<NoteViewModeSwitch value="edit" onChange={onChange} splitDisabled />);

    const btns = Array.from(qa(container, "btn"));
    expect(btns.length).toBe(3); // 置灰不隐藏
    expect((btns[1] as HTMLButtonElement).disabled).toBe(true);
    expect(btns[1].getAttribute("title")).toContain("拉宽");
    fireEvent.click(btns[1]);
    expect(onChange).not.toHaveBeenCalled();
  });
});
