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
  const appearanceTsx = readFileSync(join(root, "src", "components", "settings", "sections", "AppearanceSection.tsx"), "utf8");

  it("右控件列规则留着 :not([data-stack]) 逃生口", () => {
    expect(sharedCss).toMatch(/\.sRow > :last-child:not\(\.sToggle\):not\(\.sRowBody\):not\(\[data-stack\]\)/);
  });

  /** 🔴 没有行末控件的行，它的 `:last-child` 就是 `.sRowBody` 自己。
   *  少了这个排除，文字列被改成 `display:flex; justify-content:flex-end` ⇒
   *  「应用排除名单」实测 340–800 五档全部把标题/说明/输入框横排成一行。 */
  it("文字列（.sRowBody）永远不算「行末右控件」", () => {
    expect(sharedCss).toMatch(/\.sRow > :last-child[^\n{]*:not\(\.sRowBody\)/);
  });

  /** 六张主题卡是纵向行的 last-child：不挂标记就被拍成右对齐（首卡左偏 42px@340 / 262px@800），
   *  而降级门现在按结构数子节点，6 张卡正好会误触发——同一个标记挡两条规则。 */
  it("主题卡阵挂着 data-stack（它同时是降级门的例外）", () => {
    expect(appearanceTsx).toMatch(/themeGrid\} data-stack="true">/);
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

/**
 * 「行末宽控件饿死描述列」的降级规则（2026-10-02 三案实测的甲案）。
 *
 * jsdom 量不到布局 ⇒ 只能钉源码文本。三样少任何一样，数据管理那两行就退回
 * 「一句话折 3–6 行」的挤法（`flex-shrink:0` 又不会报错，静默回归）：
 *  ① 降级触发条件是「行末多选一 ≥4 档」（`:has(... > :nth-child(4))`），不是「行末有控件」——
 *     后者实测把 2 档行从 65px 抬到 147px，纯属误伤；
 *  ② 覆盖方式是 `:has()` 一条规则而不是逐个调用点加类名——后者一定会漏第 5 个宽控件行（规则 #11.1）；
 *  ③ basis 是实测出来的 **320**（280 会留 18px「描述照旧折行」的尴尬档）。
 *
 * 🔴 断言跑在**去注释**的 CSS 上：注释里原样记着被否掉的写法
 *    （`flex: 1 1 min(320px, max-content)`、旧版 `:has(> .sCleanup:last-child)`），
 *    拿整份文件比就把「文档」当成「代码」了。
 */
describe("行末胶囊/分段控件必须能自动降级到描述下方", () => {
  const root = process.cwd();
  const rawCss = readFileSync(join(root, "src", "components", "Settings.module.css"), "utf8");
  const sharedCss = rawCss.replace(/\/\*[\s\S]*?\*\//g, "");

  it("降级触发条件是「行末多选一 ≥4 档」，且按结构认不按类名认", () => {
    // 用字面量正则而不是 new RegExp(模板串)：字符串里 `\.` 会被 JS 先吞成 `.`
    expect(sharedCss).toMatch(
      /\.sRow:has\(> :last-child:not\(\[data-stack\]\):not\(\.sRowBody\) > :nth-child\(4\)\)\s*\{\s*flex-wrap: wrap;/
    );
    expect(sharedCss).toMatch(
      /\.sRow:has\(> :last-child:not\(\[data-stack\]\):not\(\.sRowBody\) > :nth-child\(4\)\) > \.sRowBody\s*\{/
    );
    // 旧版「行末只要有控件就降级」必须已经不在代码里（注释里留着当反面教材是允许的）
    expect(sharedCss).not.toMatch(/:has\(> \.s(?:Cleanup|SegGroup):last-child\)/);
    // 🔴 上一版门里的类名清单必须整体消失：门一旦回到「认类名」，
    // 灵动岛那颗 4 档 `.seg`（类名在 Island.module.css）就又看不见，340 档实测 556px 高。
    expect(sharedCss).not.toMatch(/:is\(\.sCleanup/);
  });

  /** 两条都是实测换来的，退回写法就分别炸成「图标悬空孤行」和「胶囊掉在行首」：
   *  ① 保底宽封顶 `100% - 52px`：写死 320 时内容列 <372（用户截图那档）图标被甩成单独一行；
   *  ② `margin-left: auto`：控件自己那行的 `justify-content:flex-end` 挪不动控件本身。 */
  it("保底宽必须封顶到 100%-52px，降下来的控件必须拉回右列", () => {
    expect(sharedCss).toMatch(/flex: 1 1 min\(320px, 100% - 52px\);/);
    expect(sharedCss).not.toMatch(/flex: 1 1 320px;/);
    expect(sharedCss).toMatch(
      /\.sRow:has\(> :last-child:not\(\[data-stack\]\):not\(\.sRowBody\) > :nth-child\(4\)\) > :last-child:not\(\.sToggle\)\s*\{\s*margin-left: auto;/
    );
  });

  it("保底宽是实测出来的 320（写回 280 就留下 18px 挤而不换行的尴尬档）", () => {
    // 🔴 不接受 `min(320px, max-content)`：Chromium 判含内在关键字为非法，整条声明被丢弃＝等于没写
    expect(sharedCss).not.toMatch(/max-content/);
    expect(sharedCss).toMatch(/min\(320px,/);
  });
});
