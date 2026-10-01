/**
 * 设置页右栅的两个**静默失效**前提。
 *
 * 失效方式都是「不报错、只是功能没了」，所以每条都要被钉住：
 *
 * A. `useSettingsSearch` 只走容器的 **直接子节点**（`container.children`）。
 *    分区组件一旦被某个 `<div>` 包起来，它那几行就从过滤器眼里消失了：
 *    搜不到、点菜单也滚不到，而页面看起来完全正常。
 *    2026-09-29 分区重排新建了 5 个分区组件，最容易顺手写 `return (<div>…</div>)`。
 *
 * B. `sections/meta.ts` 的数组顺序 = 右栅的渲染顺序（左菜单靠标题文字找落点）。
 *    这条由 `settingsNavLabels.test.ts` 的源码顺序用例钉，本文件钉 A 的两半：
 *    静态（每个分区组件必须返回片段）+ 语义（探针证明「包一层就判得出来」）。
 *
 * ❗ 用真实的 `styles.sSection` / `styles.sRow`：hook 判类别认的是 CSS module 编译后的
 *    类名（`_sSection_hash`），写死字符串会测试通过而真代码不认。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { render } from "@testing-library/react";
import type { ReactNode } from "react";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { useSettingsSearch } from "@/hooks/useSettingsSearch";
import styles from "@/components/Settings.module.css";

const SECTIONS_DIR = join(process.cwd(), "src", "components", "settings", "sections");

/** jsdom 不实现 scrollIntoView，而 hook 命中后会滚到第一条结果。 */
beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
});

function Probe({ children }: { children: ReactNode }) {
  const s = useSettingsSearch();
  return <div ref={s.containerRef} data-testid="sections">{children}</div>;
}

const head = (t: string) => <div className={styles.sSection}>{t}</div>;
const row = (t: string) => (
  <div className={styles.sRow}>
    <div className={styles.sRowLabel}>{t}</div>
  </div>
);

/** 与 hook 同一条判据：直接子节点只许是标题或设置行。 */
const isFlat = (el: HTMLElement) =>
  [...el.children].every(
    (c) => c.classList.contains(styles.sSection) || c.classList.contains(styles.sRow),
  );

describe("设置页右栅：children 必须严格扁平", () => {
  it("探针：标题 + 设置行的扁平结构判为合格", () => {
    const { getByTestId } = render(
      <Probe>
        {head("外观")}
        {row("主题配色")}
        {head("同步与互联")}
        {head("剪贴板同步")}
        {row("多台电脑自动共享剪贴板")}
      </Probe>,
    );
    const el = getByTestId("sections");
    // 先确认探针真的渲染出了这些节点，否则判据空跑也不会红。
    expect(el.children.length).toBe(5);
    expect(isFlat(el)).toBe(true);
  });

  it("包一层 div 就会被判为不合格（这条证明上一条不是空转）", () => {
    const { getByTestId } = render(
      <Probe>
        {head("外观")}
        {row("主题配色")}
        <div>
          {head("同步与互联")}
          {row("多台电脑自动共享剪贴板")}
        </div>
      </Probe>,
    );
    expect(isFlat(getByTestId("sections"))).toBe(false);
  });

  /**
   * 真代码侧的静态守卫：分区组件必须 `return (<>…</>)`。
   * 只认**顶层组件**的 `  return (`（两空格缩进），组件内部的 return 缩进更深，不会误判。
   * 允许紧跟若干行注释——这些组件普遍在 `return (` 后面写一段「为什么必须是片段」的说明。
   */
  it("sections/ 下的每个分区组件都返回片段", () => {
    const wrapped: string[] = [];
    const seen: string[] = [];
    for (const f of readdirSync(SECTIONS_DIR).filter((n) => n.endsWith(".tsx")).sort()) {
      const lines = readFileSync(join(SECTIONS_DIR, f), "utf8").split(/\r?\n/);
      let fn = "";
      for (let i = 0; i < lines.length; i++) {
        const decl = lines[i].match(/^export function (\w+)/);
        if (decl) {
          fn = decl[1];
          continue;
        }
        if (!/^ {2}return \(/.test(lines[i]) || !/(Section|Rows)$/.test(fn)) continue;
        seen.push(fn);
        let j = i + 1;
        while (j < lines.length && /^\s*(\/\/|\/\*|\*|<!--)/.test(lines[j])) j++;
        if (!/^\s*<>/.test(lines[j] ?? "")) wrapped.push(`${f}: ${fn}`);
      }
    }
    // 抓空了（正则失效）等于没测，这里先断言确实扫到了分区组件。
    expect(seen.length).toBeGreaterThan(8);
    expect(wrapped).toEqual([]);
  });
});

/**
 * 「.sRow 右控件列」与整块纵向内容之间的权重游戏（2026-10-01 设置页 UI 审查 P0 5）。
 *
 * `Settings.module.css` 那条 `.sRow > :last-child:not(.sToggle):not([data-stack])` 是 0-4-0：
 * 分区组件自己的 0-1-0 规则永远赢不了它——灵动岛的「停靠位置六宫格」和「玻璃透度滑杆」
 * 都是纵向整块、又恰好排在行末，被这条规则一拍就成右对齐单行。跨 module 也翻不了盘
 * （谁在后不由写代码的人决定）。逃生口是显式挂 `data-stack="true"`。
 *
 * 三处文本少任何一处，那两块布局就静默塌掉，而 jsdom 量不到布局 ⇒ 只能钉源码。
 */
describe("整块纵向内容必须显式退出「.sRow 右控件列」规则", () => {
  const root = process.cwd();
  const sharedCss = readFileSync(join(root, "src", "components", "Settings.module.css"), "utf8");
  const islandTsx = readFileSync(join(root, "src", "components", "settings", "sections", "IslandSection.tsx"), "utf8");
  const islandCss = readFileSync(join(root, "src", "components", "settings", "sections", "Island.module.css"), "utf8");

  it("右控件列规则留着 :not([data-stack]) 逃生口", () => {
    expect(sharedCss).toMatch(/\.sRow > :last-child:not\(\.sToggle\):not\(\[data-stack\]\)/);
  });

  it("六宫格与透度滑杆两个纵向块都挂了 data-stack", () => {
    // 断言文本里不写 `styles.` 前缀：check-css-classes 扫的是源码原文，
    // 会把字符串常量内的 `styles.glassSliderWrap` 也当成真引用报死。
    expect(islandTsx).toMatch(/glassSliderWrap\} data-stack="true"/);
    expect(islandTsx).toMatch(/anchorGrid\} data-stack="true"/);
  });

  it("Island.module.css 里的行方向靠双写类名抬权重，没退回单类名", () => {
    for (const cls of ["glassRow", "anchorRow"]) {
      expect(islandCss, cls).toMatch(new RegExp(`\\.${cls}\\.${cls}\\s*\\{`));
    }
  });
});
