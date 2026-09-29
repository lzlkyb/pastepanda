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
 */
import { describe, it, expect, beforeAll } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { useSettingsSearch } from "@/hooks/useSettingsSearch";
import styles from "@/components/Settings.module.css";

// jsdom 不实现 scrollIntoView，而命中后 hook 会滚到第一条结果（U1）。
beforeAll(() => {
  Element.prototype.scrollIntoView = () => {};
});

function Harness({ filter: initial }: { filter?: string }) {
  const s = useSettingsSearch();
  return (
    <>
      <input
        data-testid="q"
        defaultValue={initial ?? ""}
        onChange={(e) => s.setFilter(e.target.value)}
      />
      <div ref={s.containerRef}>
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
