/**
 * 设置页搜索的第二遍（分区标题显隐）护栏。
 *
 * 🔴 盯的是 2026-09-29 分区重排**实测出来**的缺陷，不是假想题：
 * 合并分区后「同步与互联」这个主标题下面直接跟三个小节标题，主标题自己一行都没有。
 * 旧算法是「本节没有可见行就连标题一起隐藏」⇒ 主标题永远 `display:none`，
 * 而 `useSettingsNav.findNavEl` 会跳过隐藏的标题，于是左菜单点「同步与互联」**没有落点**
 * （点了什么也不发生）。设计稿里复现过一次，改法在那里验过才搬回真代码。
 *
 * 新规则三条，本文件逐条钉：
 *   ① 不搜索 → 全显示（**这条才是那个 bug 的正解**：菜单只在非搜索态点，
 *      旧算法此时也把主标题隐着，于是 `findNavEl` 找不到落点）；
 *   ② 搜索时本节有可见行 → 显示；
 *   ③ 搜索时紧跟其后的是一个**可见的**标题 → 也显示（命中的小节标题要把主标题带出来）。
 *
 * ❗ 用真实的 `styles.sSection` / `styles.sRow`：hook 判类别靠的就是这两个 CSS module 类名，
 * 硬编码字符串会让测试通过而真代码不认（vitest 里 CSS module 会解析成 `_sSection_hash`）。
 *
 * 后面三组是 2026-10-01 设置页 UI 审查里查出来的四处：横幅说真话（节名命中不算「没有匹配项」）、
 * 分布串截断要折成「等 N 处」、**后渲染出来的行**也要被过滤（观察器）、
 * 以及搜索态点左菜单必须先清空关键词。
 */
import { describe, it, expect, beforeAll } from "vitest";
import { Fragment } from "react";
import { render, fireEvent, act } from "@testing-library/react";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { useSettingsSearch } from "@/hooks/useSettingsSearch";
import styles from "@/components/Settings.module.css";

// jsdom 不实现 scrollIntoView，而命中后 hook 会滚到第一条结果（U1）。
beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
});

/** 读 effect 写进 span 的文本（计数 / 横幅） */
function getText(container: HTMLElement, testid: string): string {
  const el = container.querySelector(`[data-testid="${testid}"]`);
  if (!el) throw new Error(`没有元素：${testid}`);
  return el.textContent || "";
}

/**
 * 等「观察器微任务 → rAF 重跑」这一整条走完。
 * 两帧：第一帧跑 applyFilter，第二帧保证它写 DOM 之后我们才断言。
 */
async function nextFrame() {
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => requestAnimationFrame(() => resolve()));
    });
  });
}

function Harness({ filter: initial }: { filter?: string }) {
  const s = useSettingsSearch();
  return (
    <>
      <input
        data-testid="q"
        defaultValue={initial ?? ""}
        onChange={(e) => s.setFilter(e.target.value)}
      />
      {/* 计数与横幅文本由 effect 直接写进这两个空 span（真实 DOM 里它们是
          搜索框旁的 chip 和结果条摘要），子节点必须留空，否则 React 会覆盖 */}
      <span data-testid="count" ref={s.countRef} />
      <span data-testid="summary" ref={s.summaryRef} />
      <div data-testid="sections" ref={s.containerRef}>
        {/* 主标题：自己一行都没有，三个小节标题紧跟其后 */}
        <div className={styles.sSection}>同步与互联</div>
        <div className={styles.sSection}>剪贴板同步</div>
        <div className={styles.sRow}>
          <div className={styles.sRowLabel}>多台电脑自动共享剪贴板</div>
        </div>
        <div className={styles.sSection}>远程电脑</div>
        <div className={styles.sRow}>
          <div className={styles.sRowLabel}>允许被远程协助</div>
        </div>
        {/* 普通分区：有标题有行，用来验证「不相关的节该隐藏」 */}
        <div className={styles.sSection}>外观</div>
        <div className={styles.sRow}>
          <div className={styles.sRowLabel}>主题配色</div>
        </div>
      </div>
    </>
  );
}

/** 四个分区各有 1 行命中，用来验证横幅的「等 N 处」折叠 */
function WideHarness() {
  const s = useSettingsSearch();
  return (
    <>
      <input data-testid="q" onChange={(e) => s.setFilter(e.target.value)} />
      <span data-testid="count" ref={s.countRef} />
      <span data-testid="summary" ref={s.summaryRef} />
      <div data-testid="sections" ref={s.containerRef}>
        {/* ❗ 必须用 Fragment：容器 children 一旦多一层 <div>，hook 看到的就是
            外壳而不是行，等于把「扁平契约」在这个测试里自己打破 */}
        {["分区甲", "分区乙", "分区丙", "分区丁"].map((t) => (
          <Fragment key={t}>
            <div className={styles.sSection}>{t}</div>
            <div className={styles.sRow}>
              <div className={styles.sRowLabel}>{t}里带关键词的行</div>
            </div>
          </Fragment>
        ))}
      </div>
    </>
  );
}

/** 按标题文字取那个标题元素的 display；找不到元素直接失败（不静默通过） */
function headDisplay(container: HTMLElement, text: string): string {
  const el = Array.from(container.querySelectorAll<HTMLElement>("." + styles.sSection))
    .find((n) => (n.textContent || "").trim() === text);
  if (!el) throw new Error(`没有标题元素：${text}`);
  return el.style.display;
}

function search(container: HTMLElement, kw: string) {
  fireEvent.change(container.querySelector('[data-testid="q"]') as HTMLElement, {
    target: { value: kw },
  });
}

describe("设置搜索：分区标题的显隐", () => {
  it("不搜索时全部标题可见（含自己一行都没有的主标题）", () => {
    const { container } = render(<Harness />);
    for (const t of ["同步与互联", "剪贴板同步", "远程电脑", "外观"]) {
      expect(headDisplay(container, t), t).toBe("");
    }
  });

  /**
   * 规则 ③ 只沿**紧挨着**的标题往上串，不越过一个隐藏的中间空标题。
   * 这不是漏修：要链穿过去，就得让「剪贴板同步」这种**一行都不剩**的小节标题继续显示，
   * 屏幕上就是连着两个标题、第一个底下空着——比缺个父标题难看得多。
   */
  it("命中的小节标题底下只剩它自己时，上面那两个空标题一并隐掉", () => {
    const { container } = render(<Harness />);
    search(container, "允许被远程");
    expect(headDisplay(container, "远程电脑")).toBe("");
    // 剪贴板同步 与 同步与互联 此刻底下一行可见内容都没有（那行没命中）⇒ 隐藏。
    // 「菜单点了没落点」那个真问题只发生在**不搜索**时，由第一条用例（规则 ①）钉住。
    expect(headDisplay(container, "剪贴板同步")).toBe("none");
    expect(headDisplay(container, "同步与互联")).toBe("none");
    expect(headDisplay(container, "外观")).toBe("none");
  });

  it("主标题自己一行都没有，只要紧跟着的小节标题可见，它也必须可见", () => {
    const { container } = render(<Harness />);
    search(container, "共享");
    expect(headDisplay(container, "剪贴板同步")).toBe("");
    // 🔴 这条就是那个 bug 本身：旧算法只看「本节有没有可见行」，
    //     而「同步与互联」的行全在小节标题底下 ⇒ 它永远隐藏，菜单点它没有落点。
    expect(headDisplay(container, "同步与互联")).toBe("");
    expect(headDisplay(container, "远程电脑")).toBe("none");
  });

  it("分区名本身命中 → 整节展开；后面的节仍隐藏", () => {
    const { container } = render(<Harness />);
    search(container, "外观");
    expect(headDisplay(container, "外观")).toBe("");
    expect(headDisplay(container, "同步与互联")).toBe("none");
  });

  it("搜完再清空：标题全部恢复可见（第二遍不能只单向隐藏）", () => {
    const { container } = render(<Harness />);
    search(container, "远程");
    search(container, "");
    for (const t of ["同步与互联", "剪贴板同步", "远程电脑", "外观"]) {
      expect(headDisplay(container, t), t).toBe("");
    }
  });
});

/**
 * 计数与横幅要说真话。
 *
 * 🔴 盯的是「一屏结果 + 横幅说没有匹配项」：搜「外观」这类**只命中节名**的词时，
 * 旧算法把整节展开了（visibleCount>0）却一个 direct 都没有，于是横幅写「没有匹配项」、
 * 框旁写「0 项」。用户看到的就是「明明列出来了却说没有」。
 */
describe("设置搜索：计数与横幅文本", () => {
  it("只有节名命中时，横幅说「分区名命中 · 整节 N 项」，不说没有匹配项", () => {
    const { container } = render(<Harness />);
    search(container, "外观");
    expect(getText(container, "summary")).toBe("「外观」分区名命中 · 整节 1 项");
    expect(getText(container, "count")).toBe("1 项");
  });

  it("有直接命中时照旧报命中数与所在分区", () => {
    const { container } = render(<Harness />);
    search(container, "允许被远程");
    expect(getText(container, "summary")).toBe("命中 1 项 · 分布在「远程电脑」");
    expect(getText(container, "count")).toBe("1 项");
  });

  it("什么都没命中才是「没有匹配项」", () => {
    const { container } = render(<Harness />);
    search(container, "根本不存在这个词");
    expect(getText(container, "summary")).toBe("没有匹配项");
  });

  /** 横幅可用宽度只有 ~320px，四个节名全列会把末尾挤成省略号（P1 10）。 */
  it("分布超过两个分区名时折成「等 N 处」", () => {
    const { container } = render(<WideHarness />);
    search(container, "关键词");
    const summary = getText(container, "summary");
    expect(summary).toContain("命中 4 项");
    expect(summary).toContain("等 4 处");
    expect(summary).not.toContain("分区丙");
    // 只列两个名字 = 两个开引号（分布在「甲」「乙」）
    expect(summary.match(/「/g)?.length).toBe(2);
  });
});

/**
 * 新渲染出来的行也必须被当前关键词管住（P1 8）。
 *
 * 🔴 「每次渲染都跑」只覆盖让 SettingsView 重渲染的那半边：折叠组展开、懒挂载面板
 * 填进来、条件行出现都是**子组件自己的 state**，父级一帧都不重渲染，旧代码于是让新行
 * 顶着默认 display 直接显形，而计数还说「没有匹配项」。补了观察器以后由它重跑。
 */
describe("设置搜索：后出现的行", () => {
  it("搜索中新插入的行会被同一轮过滤隐掉", async () => {
    const { container } = render(<Harness />);
    search(container, "共享");
    const sections = container.querySelector('[data-testid="sections"]') as HTMLElement;
    const late = document.createElement("div");
    late.className = styles.sRow;
    late.innerHTML = `<div class="${styles.sRowLabel}">跟关键词毫不相干的一行</div>`;
    sections.appendChild(late);
    expect(late.style.display, "插入瞬间还没重跑").toBe("");

    await nextFrame();
    expect(late.style.display, "观察器重跑后应被隐掉").toBe("none");
  });

  it("插入的行命中时留下，并计入横幅", async () => {
    const { container } = render(<Harness />);
    search(container, "共享");
    const sections = container.querySelector('[data-testid="sections"]') as HTMLElement;
    const late = document.createElement("div");
    late.className = styles.sRow;
    late.innerHTML = `<div class="${styles.sRowLabel}">再多共享一条</div>`;
    sections.appendChild(late);

    await nextFrame();
    expect(late.style.display).toBe("");
    // 新行是插到容器末尾的 ⇒ 按 DOM 顺序它归在「外观」这一节底下，横幅如实两个都列
    expect(getText(container, "summary")).toBe("命中 2 项 · 分布在「剪贴板同步」「外观」");
  });
});

/** 左菜单在搜索态的落点（P0 1）。 */
describe("设置搜索：左菜单在搜索态可点", () => {
  /**
   * 源码形状断言，不是假想题的替代品：`SettingsView` 要渲染整套 shell（invoke/配置/
   * 懒挂载），现有测试没有一个渲染得动它（见 settingsNavLabels.test.ts 同意的口径）。
   * 这里钉的是「点菜单那一下会先收掉关键词」——少了它，findNavEl 会跳过被搜索
   * 隐成 display:none 的标题，点菜单就成了死点，而重渲染还会把滚动条拽回首条命中。
   */
  /**
   * 收口成一条 `jumpTo`（规则 #11.1）：左菜单 13 项与空态里那四个「跳过去」按钮
   * 必须走同一条路。判据写在 navItem 里时，第二批入口（`GeneralTab` 的空态按钮）
   * 一定会漏——漏的那一个就是「点了没反应」的死点。
   */
  it("jumpTo 先 setFilter('') 再排滚动；菜单项与空态按钮都只经 jumpTo", () => {
    const src = readFileSync(join(process.cwd(), "src", "components", "SettingsView.tsx"), "utf8");
    const jump = src.slice(src.indexOf("const jumpTo"), src.indexOf("const navItem"));
    expect(jump).toContain('if (searching) search.setFilter("")');
    expect(jump).toContain("handleNavPick(k)");
    expect(jump.indexOf('if (searching) search.setFilter("")')).toBeLessThan(
      jump.indexOf("handleNavPick(k)"),
    );

    const seg = src.slice(
      src.indexOf("const navItem"),
      src.indexOf("styles.settingsNavIcon"),
    );
    expect(seg).toContain("jumpTo(n.key)");
    expect(seg).not.toContain("handleNavPick(n.key)");
    // 空态那四个按钮的回调也必须挂在同一个 jumpTo 上
    expect(src).toContain("onJumpPage={jumpTo}");
  });
});

/**
 * 设置页快捷键必须给弹框让路（2026-10-01 复查本轮改动时查出的真 bug）。
 *
 * 两边都是 `window` 的**捕获期**监听：设置页在挂载时就挂上，弹框（ConfirmDialog /
 * KbForgetDialog / KbPairDialog）是用户点开那一刻才挂——同相位按注册顺序跑，
 * 所以设置页永远先跑。它一旦对 Esc 分支 `stopPropagation()`，事件根本到不了弹框：
 * 搜索态里点「删除此设备」再按 Esc，清掉的是搜索词，确认框关不掉。
 *
 * 判据后来收进了 `lib/modalLayers.ts`（`blocksPageShortcuts`），因为要让路的不止弹框：
 * 快捷键浮层 `.shortcut-overlay`（它不带 `.dialog-backdrop`，当时正是漏的那一条）和
 * 正在录制的 `HotkeyRecorder`（`[data-hotkey-recording]`——它一被抢焦点就 `onBlur` 取消录制）。
 *
 * 这里钉的是形状而不是行为：渲染 SettingsView 需要整套 shell（见上面那个 describe 的说明），
 * 而这条约束失效的方式是「顺序/相位变了/闸被摘掉」，正是源码能钉住的那一类。
 * 层序本身的**行为**测试在 `dialogEscapeLayering.test.tsx`。
 */
describe("设置页快捷键在弹框在场时让路", () => {
  const src = readFileSync(
    join(process.cwd(), "src", "components", "SettingsView.tsx"),
    "utf8",
  );
  const guard = "blocksPageShortcuts()";

  it("onKey 开头就有「有浮层在场即 return」的闸，且在 Escape 分支之前", () => {
    const at = (needle: string) => {
      const i = src.indexOf(needle);
      if (i < 0) throw new Error(`源码里没有这一串：${needle}`);
      return i;
    };
    // 闸要落在 onKey 之内、且在 Escape 分支之前——否则它拦不住那次 stopPropagation
    expect(at("const onKey = (e: KeyboardEvent)")).toBeLessThan(at(guard));
    expect(at(guard)).toBeLessThan(at('e.key === "Escape"'));
  });

  it("设置页这个监听仍是捕获期注册的——它正是抢在弹框前面的原因", () => {
    expect(src).toContain('window.addEventListener("keydown", onKey, true)');
  });
});

describe("录屏小节同义名称", () => {
  function RecordingHarness() {
    const s = useSettingsSearch();
    return <>
      <input data-testid="q" onChange={(e) => s.setFilter(e.target.value)} />
      <span data-testid="count" ref={s.countRef} />
      <span data-testid="summary" ref={s.summaryRef} />
      <div data-testid="sections" ref={s.containerRef}>
        <div className={styles.sSection}>屏幕录制</div>
        <div className={styles.sRow}><div className={styles.sRowLabel}>默认画质档</div></div>
        <div className={styles.sRow}><div className={styles.sRowLabel}>录屏热键</div></div>
        <div className={styles.sRow}><div className={styles.sRowLabel}>保存目录</div></div>
        <div className={styles.sSection}>数据管理</div>
        <div className={styles.sRow}><div className={styles.sRowLabel}>导出数据</div></div>
      </div>
    </>;
  }
  it.each(["录屏", "录屏设置", "screen recording"])("搜 %s 显示录屏整节，不只显示热键", (q) => {
    const { container } = render(<RecordingHarness />);
    search(container, q);
    expect(getText(container, "count")).toBe("3 项");
    for (const label of ["默认画质档", "录屏热键", "保存目录"]) {
      const row = Array.from(container.querySelectorAll('.' + styles.sRow))
        .find((node) => node.textContent === label) as HTMLElement;
      expect(row.style.display).not.toBe("none");
    }
    const unrelated = Array.from(container.querySelectorAll('.' + styles.sRow))
      .find((node) => node.textContent === "导出数据") as HTMLElement;
    expect(unrelated.style.display).toBe("none");
  });
});
