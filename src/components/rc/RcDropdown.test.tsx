/**
 * RcDropdown 守卫单测。
 *
 * 钉住的都是**肉眼看代码看不出来**的那几条：
 * 1. 菜单必须 portal 到 body —— 它曾经是底栏内的 absolute 浮层，被 `.sessionBar`
 *    的 `overflow-y: auto` 整块裁掉（rect 照样有值、elementFromPoint 命中画面区）。
 * 2. 勾位必须**常驻**（opacity 切换），不能条件渲染 —— 一旦不渲染，未选中项的文字
 *    会比选中项左移一整个勾宽，鼠标扫过时整列文字在跳。jsdom 不算样式，
 *    所以这条只能断言「每一项里都有勾元素」。
 * 3. solo 项要独占一行、且只在「后面还有项」时补分隔线（末项补线会在菜单底部
 *    留一条悬空的横线）。
 *
 * jsdom 的 getBoundingClientRect 全返 0：按钮矩形退化为原点，弹层仍会挂载
 * （`place()` 只要拿得到 rect 就 setPos，不依赖真实尺寸）。
 */
import { describe, expect, it, vi } from "vitest";
import { fireEvent, render, screen } from "@testing-library/react";
import { RcDropdown, type RcDropdownOption } from "./RcDropdown";
import styles from "./RemoteComputer.module.css";

/** 覆盖三种项：solo 带 meta、普通带 meta、普通无 meta。 */
const OPTIONS: readonly RcDropdownOption<string>[] = [
  { key: "auto", label: "自动", tip: "按延迟自动换档", meta: "自动换档", solo: true },
  { key: "smooth", label: "流畅", tip: "约 10fps · 宽 960", meta: "10fps · 960" },
  { key: "plain", label: "仅主屏", tip: "只看主显示器" },
];

function openMenu(over?: {
  columns?: 1 | 2;
  value?: string;
  options?: readonly RcDropdownOption<string>[];
}) {
  const onPick = vi.fn();
  render(
    <RcDropdown
      label="画质"
      value={over?.value ?? "auto"}
      options={over?.options ?? OPTIONS}
      columns={over?.columns}
      onPick={onPick}
    />,
  );
  fireEvent.click(screen.getByRole("button", { name: /画质/ }));
  return { menu: screen.getByRole("listbox"), onPick };
}

const items = () => screen.getAllByRole("option");

describe("RcDropdown 底栏下拉", () => {
  it("菜单挂到 body 上，不在底栏容器里（回归「被 overflow 裁掉」）", () => {
    const { menu } = openMenu();
    expect(menu.parentElement).toBe(document.body);
  });

  it("每一项都渲染勾位（常驻），可见性交给 CSS", () => {
    openMenu();
    for (const it of items()) {
      expect(it.querySelectorAll("svg")).toHaveLength(1);
    }
  });

  it("选中项带高亮类，且恰有一项被选中", () => {
    openMenu();
    const on = items().filter((it) => it.className.includes(styles.menuItemOn));
    expect(on).toHaveLength(1);
    expect(on[0].textContent).toContain("自动");
    expect(on[0].getAttribute("aria-selected")).toBe("true");
  });

  it("meta 渲染在 label 右侧；没有 meta 的项不渲染空占位", () => {
    openMenu();
    expect(screen.getByText("10fps · 960")).toBeTruthy();
    const plain = items().find((it) => it.textContent?.includes("仅主屏"));
    expect(plain?.querySelector(`.${styles.menuMeta}`)).toBeNull();
  });

  it("solo 项独占一行，其后紧跟一条分隔线", () => {
    const { menu } = openMenu();
    const solo = items()[0];
    expect(solo.className).toContain(styles.menuItemSolo);
    expect(solo.nextElementSibling?.className).toContain(styles.menuSep);
    expect(menu.querySelectorAll(`.${styles.menuSep}`)).toHaveLength(1);
  });

  it("solo 落在末项时不补分隔线（免得底部多一条悬空的线）", () => {
    const { menu } = openMenu({
      options: [
        { key: "a", label: "A", tip: "a" },
        { key: "b", label: "B", tip: "b", solo: true },
      ],
    });
    expect(menu.querySelectorAll(`.${styles.menuSep}`)).toHaveLength(0);
  });

  // ⚠️ 一个 it 里只 render 一次：RTL 的自动清理在 afterEach，同一 it 内 render 两次
  // 会让 `screen` 同时看到两份 DOM（`getByRole` 直接报 found multiple）。
  it("columns=2 → 容器带双列类", () => {
    expect(openMenu({ columns: 2 }).menu.className).toContain(styles.menuPopTwo);
  });

  it("默认单列 → 不带双列类（列数由调用方按 label 长度指定）", () => {
    expect(openMenu().menu.className).not.toContain(styles.menuPopTwo);
  });

  it("点一项：回调拿到 key，菜单收起", () => {
    const { onPick } = openMenu();
    fireEvent.click(screen.getByText("10fps · 960"));
    expect(onPick).toHaveBeenCalledWith("smooth");
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("在菜单外按下鼠标就关闭（mousedown，不等 click）", () => {
    const { menu } = openMenu();
    fireEvent.mouseDown(menu);
    expect(screen.queryByRole("listbox")).not.toBeNull();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("🔴 Esc 两级取消：展开时按 Esc 收起自己（第一级回上一步，不落到结束会话）", () => {
    openMenu();
    expect(screen.queryByRole("listbox")).not.toBeNull();
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
    // 再按一次 Esc：面板已收、计数归零，事件不再被这里拦截（会话兜底可接管）
    fireEvent.keyDown(document, { key: "Escape" });
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});
