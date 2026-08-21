/**
 * 右键菜单的**开合与目标正确性**。
 *
 * 修的症状（两条都实测复现过）：
 * 1) 空白区右键会把**上一次那张卡片**的菜单原样弹出来 —— handleContextMenu 只 setPos、
 *    从不 setItems，而关闭时也只 setPos(null)、items 永不清空。于是点「删除」删掉的是
 *    用户根本没在上面右键的那张卡。还没右键过任何卡片时 items 是 []，会挂出一个
 *    没有任何菜单项的空玻璃方块。
 * 2) 菜单只在 mousedown / contextmenu 时关闭，滚动、失焦、改窗口大小都不关。菜单是
 *    position:fixed，列表一滚它就停在原坐标指着别的卡片 —— 和第 1 条叠起来更迷惑。
 *
 * 定下的行为：空白区右键**什么都不弹**（只 preventDefault 挡掉 webview 原生菜单）。
 * 于是 items 只有一个来源——卡片自己调 trigger，不可能再继承上一次的。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { useContext } from "react";
import { render, screen, fireEvent, waitFor, act, cleanup } from "@testing-library/react";
import { ContextMenu, CtxMenuCtx, type MenuItem } from "@/components/ContextMenu";
import { useAppStore } from "@/stores/appStore";

vi.mock("@/lib/regexRules", () => ({ getEnabledRules: () => [] }));

const onDeleteA = vi.fn();

/** 卡片A 的菜单项 */
const CARD_A_ITEMS: MenuItem[] = [{ icon: null, label: "删除卡片A", onClick: onDeleteA }];

/**
 * 测试床：一个"开卡片A菜单"的按钮 + 一块空白区 + 一个可滚动容器。
 * 空白区不带 data-item-id，右键它就是走 ContextMenu 的包装器分支。
 */
function Harness() {
  const trigger = useContext(CtxMenuCtx);
  return (
    <>
      <button onClick={() => trigger?.(10, 10, CARD_A_ITEMS)}>开A</button>
      <button onClick={() => trigger?.(10, 10, [])}>开空菜单</button>
      <div data-testid="blank" style={{ width: 200, height: 200 }} />
      <div data-testid="scroller" style={{ overflow: "auto", height: 50 }}>
        <div style={{ height: 500 }} />
      </div>
    </>
  );
}

/** 菜单容器（CSS Module 哈希后类名形如 _ctxMenu_ab999e）。批 2 加上 role="menu" 后可换成 getByRole */
const menuBox = () => document.querySelector('[class*="ctxMenu"]');

/** 等一帧：关闭监听器是在 requestAnimationFrame 里注册的 */
const nextFrame = () =>
  act(async () => {
    await new Promise<void>((r) => requestAnimationFrame(() => r()));
  });

/** 开一次卡片A的菜单，并等关闭监听器就位 */
async function openCardAMenu() {
  fireEvent.click(screen.getByText("开A"));
  expect(screen.getByText("删除卡片A")).toBeTruthy();
  await nextFrame();
}

beforeEach(() => {
  cleanup();
  vi.clearAllMocks();
  useAppStore.setState({ focusId: null, selectedIds: new Set<string>() });
  render(
    <ContextMenu>
      <Harness />
    </ContextMenu>,
  );
});

describe("空白区右键不该借用上一次的菜单", () => {
  it("从没右键过卡片时，右键空白区不弹菜单（原 bug：挂出一个没有菜单项的空方块）", () => {
    fireEvent.contextMenu(screen.getByTestId("blank"));
    expect(menuBox()).toBeNull();
  });

  it("右键卡片A→关闭→右键空白区，不能再出现卡片A的菜单项", async () => {
    await openCardAMenu();

    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(screen.queryByText("删除卡片A")).toBeNull());

    fireEvent.contextMenu(screen.getByTestId("blank"));
    // 原 bug：这里会把卡片A的菜单整份弹回来，点「删除」删的是A
    expect(screen.queryByText("删除卡片A")).toBeNull();
    expect(menuBox()).toBeNull();
  });

  it("菜单开着时右键空白区，菜单关闭而不是换个位置继续显示A", async () => {
    await openCardAMenu();
    fireEvent.contextMenu(screen.getByTestId("blank"));
    await waitFor(() => expect(screen.queryByText("删除卡片A")).toBeNull());
  });

  it("仍然要 preventDefault，否则 webview 会弹自己的原生菜单", () => {
    const e = new MouseEvent("contextmenu", { bubbles: true, cancelable: true });
    screen.getByTestId("blank").dispatchEvent(e);
    expect(e.defaultPrevented).toBe(true);
  });

  it("菜单项为空数组时不渲染菜单容器（Card 那边有 `menuItems || []` 兜底，会传空）", () => {
    fireEvent.click(screen.getByText("开空菜单"));
    expect(menuBox()).toBeNull();
  });

  it("Shift+F10 在没有聚焦卡片时不弹菜单（同一处陈旧 items 的回退分支）", async () => {
    await openCardAMenu();
    fireEvent.mouseDown(document.body);
    await waitFor(() => expect(screen.queryByText("删除卡片A")).toBeNull());

    fireEvent.keyDown(window, { key: "F10", shiftKey: true });
    expect(screen.queryByText("删除卡片A")).toBeNull();
    expect(menuBox()).toBeNull();
  });
});

describe("菜单要跟着视口变化关闭", () => {
  it("列表滚动时关闭（菜单是 fixed，滚完就指着别的卡片了）", async () => {
    await openCardAMenu();
    fireEvent.scroll(screen.getByTestId("scroller"));
    await waitFor(() => expect(screen.queryByText("删除卡片A")).toBeNull());
  });

  it("滚轮滚动时关闭", async () => {
    await openCardAMenu();
    fireEvent.wheel(screen.getByTestId("blank"), { deltaY: 100 });
    await waitFor(() => expect(screen.queryByText("删除卡片A")).toBeNull());
  });

  it("窗口失焦时关闭（切到别的程序回来不该还挂着）", async () => {
    await openCardAMenu();
    fireEvent.blur(window);
    await waitFor(() => expect(screen.queryByText("删除卡片A")).toBeNull());
  });

  it("窗口尺寸变化时关闭（翻折位置已经算错了）", async () => {
    await openCardAMenu();
    fireEvent.resize(window);
    await waitFor(() => expect(screen.queryByText("删除卡片A")).toBeNull());
  });

  it("子菜单自己限高滚动时不能把菜单关掉（滚的是菜单内部）", async () => {
    await openCardAMenu();
    const box = menuBox();
    expect(box).not.toBeNull();
    fireEvent.wheel(box!, { deltaY: 100 });
    fireEvent.scroll(box!);
    // 菜单内部的滚动与关闭无关，菜单应该还在
    expect(screen.getByText("删除卡片A")).toBeTruthy();
  });
});
