/**
 * 全屏编辑器「工作台化」令牌与布局守卫（2026-09 方案A/C）。
 *
 * 两个必须靠读源码才能验证的东西（jsdom 不解析 CSS Module 的值）：
 *   ① **5 个新令牌 × 6 套主题 = 30 处**都要存在 —— 漏一套主题，
 *      该主题下工作区/状态栏就是透明的，而 tsc / vitest 都不会报错；
 *   ② `.fileName` / `.filePath` 的 **flex 收缩分工**（B1）——
 *      「文件名不收缩、路径可收缩」是纯 CSS 行为，渲染测试看不出来。
 *
 * 🔴 为什么令牌必须逐主题写而不是在 `:root` 派生一次：
 *    `--section-bg` **不在 `:root` 里**，只在各主题块。CSS 自定义属性继承的是
 *    **已计算的值** —— `:root` 上派生出失效值后，子元素不会拿自己作用域里的
 *    `--section-bg` 重新求值。所以 6 套主题一个都不能少。
 */
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const theme = readFileSync(resolve(root, "src/styles/theme.css"), "utf8");
const editorCss = readFileSync(
  resolve(root, "src/components/editors/FullscreenEditor.module.css"),
  "utf8"
);

const WORKBENCH_TOKENS = [
  "--workbench-bg",
  "--chrome-bg",
  "--paper-bg",
  "--status-bg",
  "--status-border",
] as const;

describe("工作台层级令牌（方案A：落进 theme.css）", () => {
  it("5 个令牌 × 6 套主题全部有定义", () => {
    for (const token of WORKBENCH_TOKENS) {
      const hits = theme.match(new RegExp(`^\\s*${token}:`, "gm")) ?? [];
      expect(hits.length, `${token} 应有 6 处（六套主题各一）`).toBe(6);
    }
  });

  it("全部从现有令牌派生，不写死颜色", () => {
    for (const token of WORKBENCH_TOKENS) {
      const re = new RegExp(`^\\s*${token}:\\s*(.+);`, "gm");
      const values = [...theme.matchAll(re)].map((m) => m[1]);
      expect(values.length).toBe(6);

      for (const v of values) {
        // 允许 var(--x) 与 color-mix(..., var(--x), var(--y))，但不允许字面色值
        expect(v, `${token} 的值不应写死颜色：${v}`).not.toMatch(/#[0-9a-f]{3,8}\b/i);
        expect(v, `${token} 应从现有令牌派生：${v}`).toMatch(/var\(--/);
      }
    }
  });

  it("六套主题里的派生式完全一致（防止某套被单独改歪）", () => {
    for (const token of WORKBENCH_TOKENS) {
      const values = [...theme.matchAll(new RegExp(`^\\s*${token}:\\s*(.+);`, "gm"))].map((m) =>
        m[1].trim()
      );
      const uniq = [...new Set(values)];
      expect(uniq.length, `${token} 在六套主题里的表达式应完全相同，实际有 ${uniq.length} 种`)
        .toBe(1);
    }
  });
});

describe("中性状态栏（P0-6）", () => {
  const statusBar = editorCss.slice(
    editorCss.indexOf(".statusBar {"),
    editorCss.indexOf(".statusLeft, .statusRight")
  );
  /** 去掉注释：本文件里的注释会解释「原先用的是什么」，直接查全串会误命中说明文字 */
  const stripComments = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");
  const statusBarCode = stripComments(statusBar);

  it("不再使用版本徽章的蓝渐变，改用中性表面令牌", () => {
    // 原实现借了 --version-badge-gradient 当底色 —— 那是「版本号徽章」的皮肤
    expect(statusBarCode).not.toContain("--version-badge-gradient");
    expect(statusBarCode).not.toMatch(/rgba\(255,\s*255,\s*255/); // 也不该再有白字
    expect(statusBarCode).toContain("var(--status-bg");
    expect(statusBarCode).toContain("var(--status-border");
  });

  it("右侧保存态永不收缩（规则 15：反馈与触发同域可见）", () => {
    const right = editorCss.slice(
      editorCss.indexOf("/* 🔴 右侧（保存态 + 类型）"),
      editorCss.indexOf("/* 左侧是可牺牲的一侧")
    );
    expect(right).toContain(".statusRight");
    expect(right).toContain("flex-shrink: 0");
  });

  it("保存态是带色徽章：四种状态各有一组语义色", () => {
    for (const cls of [".saveBadgeSaved", ".saveBadgeSaving", ".saveBadgeDirty", ".saveBadgeFailed"]) {
      expect(editorCss, `${cls} 应定义`).toContain(cls);
    }
    // 每组都应是「主色 + 底 + 描边」三件套，而不是只有一个 color
    expect(editorCss).toMatch(/\.saveBadgeSaved\s*\{[^}]*color:\s*var\(--success/);
    expect(editorCss).toMatch(/\.saveBadgeSaved\s*\{[^}]*background:\s*var\(--success-bg/);
    // 「保存中」走 accent 中性过渡色（稿子 saving 态），不与失败态抢重
    expect(editorCss).toMatch(/\.saveBadgeSaving\s*\{[^}]*color:\s*var\(--accent-strong/);
    expect(editorCss).toMatch(/\.saveBadgeSaving\s*\{[^}]*background:\s*var\(--accent-light/);
    expect(editorCss).toMatch(/\.saveBadgeDirty\s*\{[^}]*background:\s*var\(--warning-bg/);
    expect(editorCss).toMatch(/\.saveBadgeFailed\s*\{[^}]*background:\s*var\(--danger-bg/);
    // 图形编码：圆点用 currentColor，跟语义色走
    expect(editorCss).toMatch(/\.saveBadgeDot\s*\{[^}]*background:\s*currentColor/);
  });
});

describe("文件名区 flex 分工（B1）", () => {
  function block(selector: string): string {
    const start = editorCss.indexOf(`${selector} {`);
    expect(start, `${selector} 应存在`).toBeGreaterThan(-1);
    return editorCss.slice(start, editorCss.indexOf("}", start));
  }

  it("文件名永不收缩 —— 它是用户确认「在编辑哪个文件」的唯一依据", () => {
    const fn = block(".fileName");
    expect(fn).toContain("flex-shrink: 0");
    expect(fn).toContain("text-overflow: ellipsis");
  });

  it("路径可收缩且带省略号 —— 它只用来区分同名文件", () => {
    const fp = block(".filePath");
    expect(fp).toContain("flex-shrink: 1");
    // min-width:0 是让 ellipsis 真正生效的前提（否则 flex 子项按内容撑开）
    expect(fp).toMatch(/min-width:\s*0/);
    expect(fp).toContain("text-overflow: ellipsis");
  });

  it("编排区字号行高与真实值一致（C1 校正结果，勿改回 12.5px）", () => {
    const cm = editorCss.slice(editorCss.indexOf(".editorBody :global(.cm-editor)"));
    expect(cm).toMatch(/font-size:\s*13\.5px/);
    expect(cm).toMatch(/line-height:\s*1\.65/);
    expect(editorCss).not.toContain("12.5px;\n  line-height: 1.75");
  });

  it("带浮层的容器 z-index 必须 ≥ 30（层叠上下文困住 menuPop 的教训）", () => {
    // position+z-index 创建层叠上下文：formatBar 若用通用 z-1，菜单（menuPop z-30）
    // 会被困在内部，DOM 在后的 .main 整层画在菜单上面 → 点菜单项点到编辑器。
    // 历史：工具栏导出下拉（z-20）被困出过同款 bug，.toolbar 因此特意 z-30。
    const fb = block(".formatBar");
    const z = Number(fb.match(/z-index:\s*(\d+)/)?.[1]);
    expect(z).toBeGreaterThanOrEqual(30);
    // main 自己不持有浮层，允许低；但 formatBar 高于 main 是菜单可见的前提
    const main = Number(block(".main").match(/z-index:\s*(\d+)/)?.[1] ?? 0);
    expect(z).toBeGreaterThan(main);
  });
});
