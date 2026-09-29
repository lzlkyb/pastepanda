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
 * jsdom 的 getBoundingClientRect 全返 0，Floating UI 也算不出真坐标，所以这里
 * 一律不断言数值（assertions 会空转）；弹层在任何矩形下都会挂载，`isPositioned`
 * 只影响一个 `visibility:hidden` 的 class，不影响 role 查询。
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { RcDropdown, type RcDropdownOption } from "./RcDropdown";
import styles from "./RemoteComputer.module.css";

const SRC = readFileSync(join(process.cwd(), "src", "components", "rc", "RcDropdown.tsx"), "utf8");
const CSS = readFileSync(
  join(process.cwd(), "src", "components", "rc", "RemoteComputer.module.css"),
  "utf8",
);

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

/**
 * 🔴 定位收口（2026-09-29）。坏掉的不是外观而是「方向被写死」：旧代码
 * `bottom: innerHeight - btn.top + 6` 把菜单钉在按钮**上方**，而浮条统一（2026-09-28）
 * 之后三档下拉全住在画面顶缘的胶囊里 → 往上弹正好开出视口上沿，画质那 8 项被截断。
 *
 * 规则 11.1 的口径：修法必须是「让中间件判方向」，不是往那条手算公式上再补一个
 * `if (btn.top < 300)`。jsdom 全零矩形，量不出坐标也翻不出向，所以这里守的是
 * **机制本身**（还在不在、有没有被逐处写死），坐标手感留给实机点验。
 */
describe("RcDropdown 定位（Floating UI 收口）", () => {
  it("🔴 不许再手算视口坐标：方向交给 flip", () => {
    expect(SRC).not.toMatch(/window\.inner(Height|Width)/);
    // 手算那一套整个拆干净：没有坐标 state，也没有 place() 了
    //（`size` 里读一次 reference 宽度对齐按钮是中间件的正经用法，不算手算）
    expect(SRC).not.toMatch(/setPos|const place\b|type Pos\b/);
    expect(SRC).not.toMatch(/bottom:\s*(window|b\.|pos)/);
    expect(SRC).toMatch(/flip\(\{[^}]*fallbackPlacements:\s*\["top-start"\]/);
    // 基准方向是**向下**：宿主在画面顶缘，下方才是整片放菜单的空间
    expect(SRC).toMatch(/placement:\s*"bottom-start"/);
    // portal 在 body 上，absolute 会跟着文档流跑（旧代码同样是 fixed）
    expect(SRC).toMatch(/strategy:\s*"fixed"/);
    // 窗口 resize / 画面滚动 / 底栏换行都要重算（旧代码自己挂的两个监听）
    expect(SRC).toMatch(/whileElementsMounted:\s*autoUpdate/);
  });

  it("贴边留白只有 EDGE_PAD 一个数，三个中间件共用", () => {
    for (const mw of ["flip", "shift", "size"]) {
      expect(SRC, `${mw} 的 padding 没读 EDGE_PAD（各处写死就会分叉）`).toMatch(
        new RegExp(`${mw}\\(\\{[^}]*padding:\\s*EDGE_PAD`),
      );
    }
  });

  it("size 同时封顶宽与高：上下都放不下的极矮窗口退化成滚动菜单", () => {
    expect(SRC).toMatch(/maxHeight:\s*`\$\{availableHeight\}px`/);
    // 旧代码的「菜单至少和按钮一样宽」要跟着搬过来，别在迁移时丢掉
    expect(SRC).toMatch(/minWidth:\s*`\$\{Math\.min\(refW, availableWidth\)\}px`/);
    // 封了高度就必须有人接手滚动，否则 max-height 只是把菜单剪掉
    const menuPop = CSS.match(/(?:^|\n)\.menuPop\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(menuPop).toMatch(/overflow:[^;]*(auto|scroll)/);
  });

  it("首帧遮罩类存在（旧「先定位再开」的等价物）", () => {
    const pending = CSS.match(/(?:^|\n)\.menuPopPending\s*\{([^}]*)\}/);
    expect(pending, "找不到 .menuPopPending —— 坐标到位前那一帧会拿旧坐标闪一下").not.toBeNull();
    expect(pending![1]).toMatch(/visibility:\s*hidden/);
    expect(SRC).toMatch(/isPositioned\s*\?\s*""\s*:\s*`\s*\$\{styles\.menuPopPending\}`/);
  });

  it("⋯ 面板自己也封顶，顶部偏移只从 --cap-zone-top 来", () => {
    const more = CSS.match(/(?:^|\n)\.capMore\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(more).toMatch(/max-height:/);
    expect(more, "封顶高度要读变量：全屏时顶缘偏移是 0，写死 36px 会多扣一条顶栏").toMatch(
      /var\(--cap-zone-top/,
    );
    expect(more).toMatch(/overflow-y:\s*auto/);
    const zone = CSS.match(/(?:^|\n)\.capZone\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(zone).toMatch(/--cap-zone-top:/);
    // 全屏档改的是变量，不再是第二条 top（两处写死迟早对不上）
    const fs = CSS.match(/(?:^|\n)\.capZoneFs\s*\{([^}]*)\}/)?.[1] ?? "";
    expect(fs).toMatch(/--cap-zone-top:\s*0px/);
    expect(fs).not.toMatch(/(?:^|[^-\w])top:/);
  });
});
