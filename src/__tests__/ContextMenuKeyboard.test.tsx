/**
 * 右键菜单的**键盘导航与无障碍语义**。
 *
 * 修的症状：
 * 1) 子菜单方向键走不动，还会静默跳到无关的顶层项 —— ArrowDown/ArrowUp 无条件
 *    `setActiveSubIndex(null)` 再移动父项索引，缺"已在子菜单内则移动子项"的分支。
 *    实测：ArrowDown → ArrowRight（进子菜单）→ ArrowDown → Enter，触发的是**顶层第 2 项**。
 *    后果是键盘用户只能碰到每个子菜单的第一个子项；而「删除」紧跟在「更多操作」之后，
 *    在「更多操作」里按 ArrowDown 会跳到「删除」，Enter 直接删。
 * 2) 菜单没有 menu 语义：容器没有 role="menu"、子项是裸 button、子菜单父项没有
 *    aria-expanded；外层包装器反而挂了 role="application"，会让屏幕阅读器对整个
 *    列表进入应用模式。打开不移焦、关闭不还焦。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useContext } from "react";
import { render, screen, fireEvent, waitFor, cleanup } from "@testing-library/react";
import { ContextMenu, CtxMenuCtx, type MenuItem } from "@/components/ContextMenu";

vi.mock("@/lib/regexRules", () => ({ getEnabledRules: () => [] }));

const sub1 = vi.fn();
const sub2 = vi.fn();
const sub3 = vi.fn();
const top1 = vi.fn();
const topLast = vi.fn();

/** 仿真实菜单的形状：顶层第 1 项普通、第 2 项是子菜单父项、最后一项是「删除」 */
const ITEMS: MenuItem[] = [
  { icon: null, label: "复制到剪贴板", onClick: top1 },
  {
    icon: null,
    label: "更多操作",
    children: [
      // 没有 onClick 的非交互项（分组标题）必须被方向键跳过
      { icon: null, label: "分组标题" },
      { icon: null, label: "编辑标签", onClick: sub1 },
      { icon: null, label: "移动到分组", onClick: sub2 },
      { icon: null, label: "添加到片段库", onClick: sub3 },
    ],
  },
  { icon: null, label: "删除", onClick: topLast, danger: true },
];

function Harness() {
  const trigger = useContext(CtxMenuCtx);
  return <button onClick={() => trigger?.(10, 10, ITEMS)}>开菜单</button>;
}

const key = (k: string) => fireEvent.keyDown(window, { key: k });

/** 打开菜单并把键盘焦点推进到「更多操作」的子菜单第一个可点子项 */
function enterSubmenu() {
  key("ArrowDown"); // 复制到剪贴板
  key("ArrowDown"); // 更多操作
  key("ArrowRight"); // 进子菜单 → 应落在「编辑标签」（跳过「分组标题」）
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  render(
    <ContextMenu>
      <Harness />
    </ContextMenu>,
  );
  fireEvent.click(screen.getByText("开菜单"));
});

describe("子菜单方向键", () => {
  it("进子菜单后 ArrowDown 走到第 2 个子项（原 bug：跳出去打到顶层第 3 项）", () => {
    enterSubmenu();
    key("ArrowDown");
    key("Enter");
    expect(sub2).toHaveBeenCalledTimes(1);
    expect(sub1).not.toHaveBeenCalled();
    expect(topLast).not.toHaveBeenCalled(); // 绝不能误触「删除」
  });

  it("子菜单内 ArrowUp 回到上一个子项", () => {
    enterSubmenu();
    key("ArrowDown"); // 移动到分组
    key("ArrowUp"); // 回到 编辑标签
    key("Enter");
    expect(sub1).toHaveBeenCalledTimes(1);
  });

  it("子菜单内走到最后一项后再按 ArrowDown 停住，不会溢出到顶层", () => {
    enterSubmenu();
    key("ArrowDown"); // 移动到分组
    key("ArrowDown"); // 添加到片段库（最后一个可点项）
    key("ArrowDown"); // 应该停在原地
    key("ArrowDown");
    key("Enter");
    expect(sub3).toHaveBeenCalledTimes(1);
    expect(topLast).not.toHaveBeenCalled();
  });

  it("子菜单内走到第一项后再按 ArrowUp 停住，不会退回非交互的分组标题", () => {
    enterSubmenu();
    key("ArrowUp");
    key("ArrowUp");
    key("Enter");
    expect(sub1).toHaveBeenCalledTimes(1);
  });

  it("方向键跳过没有 onClick 的非交互子项", () => {
    enterSubmenu();
    key("Enter"); // 进来就该落在「编辑标签」而不是「分组标题」
    expect(sub1).toHaveBeenCalledTimes(1);
  });

  it("ArrowLeft 退出子菜单，回到父项层级", () => {
    enterSubmenu();
    key("ArrowLeft");
    key("ArrowDown"); // 已经退出子菜单 → 在顶层往下走到「删除」
    key("Enter");
    expect(topLast).toHaveBeenCalledTimes(1);
    expect(sub1).not.toHaveBeenCalled();
  });

  it("Home / End 在顶层跳到首项和末项", () => {
    key("End");
    key("Enter");
    expect(topLast).toHaveBeenCalledTimes(1);
  });

  it("Home / End 在子菜单内跳到首个和最后一个子项", () => {
    enterSubmenu();
    key("End");
    key("Enter");
    expect(sub3).toHaveBeenCalledTimes(1);
  });
});

describe("无障碍语义", () => {
  it("菜单容器是 role=menu", () => {
    expect(screen.getByRole("menu")).toBeTruthy();
  });

  it("菜单项是 role=menuitem", () => {
    expect(screen.getByRole("menuitem", { name: /复制到剪贴板/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /删除/ })).toBeTruthy();
  });

  it("子菜单父项声明 aria-haspopup，并用 aria-expanded 反映展开状态", () => {
    const parent = screen.getByRole("menuitem", { name: /更多操作/ });
    expect(parent.getAttribute("aria-haspopup")).toBe("menu");
    expect(parent.getAttribute("aria-expanded")).toBe("false");

    key("ArrowDown");
    key("ArrowDown");
    key("ArrowRight");
    expect(screen.getByRole("menuitem", { name: /更多操作/ }).getAttribute("aria-expanded")).toBe("true");
  });

  it("外层包装器不再用 role=application（会让读屏对整个列表进入应用模式）", () => {
    expect(screen.queryByRole("application")).toBeNull();
  });

  it("aria-activedescendant 指向当前高亮项", () => {
    key("ArrowDown");
    const menu = screen.getByRole("menu");
    const active = menu.getAttribute("aria-activedescendant");
    expect(active).toBeTruthy();
    expect(document.getElementById(active!)?.textContent).toContain("复制到剪贴板");
  });

  it("打开时焦点进入菜单，关闭后还焦到触发它的元素", async () => {
    cleanup();
    render(
      <ContextMenu>
        <Harness />
      </ContextMenu>,
    );
    const btn = screen.getByText("开菜单");
    btn.focus();
    expect(document.activeElement).toBe(btn);

    fireEvent.click(btn);
    const menu = screen.getByRole("menu");
    await waitFor(() => expect(menu.contains(document.activeElement)).toBe(true));

    key("Escape");
    await waitFor(() => expect(document.activeElement).toBe(btn));
  });
});
