/**
 * 左菜单的 label 必须与右栅的**分区标题逐字一致**。
 *
 * 🔴 这条约束 `sections/meta.ts` 的注释里写了，但一直没测试钉着。
 * 而它是两个机制的地基：
 * - `findNavEl` 靠**标题文字全等匹配**找滚动目标（对不上 ⇒ 点菜单不滚）；
 * - scroll-spy 同样靠它反查菜单项（对不上 ⇒ 高亮不跟随）。
 *
 * 两者都**不报错**，只是静默不工作。
 * 2026-09-09 把「局域网同步」改名为「剪贴板同步」时靠的就是这条约束，
 * 而当时它没有任何测试。
 *
 * ❗ 只钉**单向**：每个菜单 label 都得有一个同名标题。反方向不钉——
 *   右栅允许有**不入菜单**的小标题（`WindowEditorSection` 的「转笔记模板」、
 *   `McpTab` 的「知识库 MCP 服务」），scroll-spy 里已明写「认不出的标题直接跳过」。
 *   双向相等会把那两个合法的额外标题误报成错。
 *   例外是 `SETTINGS_SUBSECTIONS` 里那三个**当锚点用**的小标题：它们不进菜单，
 *   但外部跳转按它的文字找落点，所以对它们要单独钉一条（见下面「小节锚点」）。
 *
 * 为何扫源码而不渲染：整个 `SettingsView` 要一大堆 Tauri 桩。
 * 而这条约束本质上就是两处源码字面的一致性，扫源码直接就能钉。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  SETTINGS_SECTIONS, SETTINGS_SUBSECTIONS, settingsNavItems,
} from "@/components/settings/sections/meta";

const ROOT = join(process.cwd(), "src", "components", "settings");

/** 所有可能写分区标题的文件。 */
function sourceFiles(): string[] {
  const out = [join(process.cwd(), "src", "components", "SettingsView.tsx")];
  for (const f of readdirSync(join(ROOT, "sections"))) {
    if (f.endsWith(".tsx")) out.push(join(ROOT, "sections", f));
  }
  for (const f of readdirSync(ROOT)) {
    if (f.endsWith(".tsx")) out.push(join(ROOT, f));
  }
  return out;
}

/**
 * 从源码里抓 `<div className={X.sSection}>标题</div>`，**不限定别名**。
 *
 * ❗ 别名不能写死成 `styles`。CSS module 拆分后，一个分区可以同时 import 两个
 * 模块（自己的 + 设置页共用的那个），于是标题类通常来自**共用模块**，别名也就
 * 成了 `shared` / `settings`：
 *   `AppearanceSection` → `import shared from "../../Settings.module.css"`
 *   `RcSection`         → 同上
 *   `StatsSection`      → `import settings from "../../Settings.module.css"`
 * 这些渲染出来的类仍然是 `Settings.module.css` 的 `sSection`，行为与拆之前一致；
 * 写死 `styles` 只会让正则抓不到、测试空红。别名的有效性由
 * `scripts/check-css-classes.mjs` 负责（它才真正验证 `X.sSection` 能解析）。
 */
function sectionTitles(): Set<string> {
  const re = /className=\{([A-Za-z_$][\w$]*)\.sSection\}>([^<]+)</g;
  const titles = new Set<string>();
  for (const p of sourceFiles()) {
    const src = readFileSync(p, "utf8");
    for (const m of src.matchAll(re)) titles.add(m[2].trim());
  }
  return titles;
}

/**
 * `GeneralTab` 里分区组件的**书写顺序**，以及每个组件的**第一个分区标题**。
 *
 * 🔴 2026-09-29 分区重排新增的约束：渲染顺序必须与 `SETTINGS_SECTIONS` 逐位一致。
 * 两边都是数组，谁忘了改另一边**都不报错**——只是点菜单滚到隔壁分区，
 * 而 scroll-spy 的高亮会跟着错。存量测试只钉了「label 与标题逐字相等」，
 * 钉不住顺序，所以这里按同样的「扫源码不渲染」路子补上。
 */
function renderOrderTitles(): string[] {
  const src = readFileSync(join(ROOT, "GeneralTab.tsx"), "utf8");
  // import { AppearanceSection } from "./sections/AppearanceSection"
  const file = new Map<string, string>();
  for (const m of src.matchAll(/import \{ (\w+) \} from "\.\/sections\/(\w+)"/g)) {
    file.set(m[1], join(ROOT, "sections", `${m[2]}.tsx`));
  }
  const out: string[] = [];
  for (const m of src.matchAll(/<([A-Z]\w*Section)[\s>]/g)) {
    const path = file.get(m[1]);
    if (!path) continue;
    const first = readFileSync(path, "utf8").match(
      /className=\{[A-Za-z_$][\w$]*\.sSection}>([^<]+)</,
    );
    if (first) out.push(first[1].trim());
  }
  return out;
}

/**
 * 最窄一档左菜单留给**文字**的宽度（px）。
 * `.settingsNav` 是 `flex: 0 0 20% / min-width: 128px`，再扣掉
 * 左边框 3 + 左右内边距 28 + 图标间隙 8 + 图标 16（14px 字号的 emoji 前进宽度）⇒ 72，
 * 真浏览器按同一套盒模型量到的是 **70**，这里取量到的那个。
 */
const NAV_TEXT_PX = 70;
const GLYPH_PX = 12.5; // `.settingsNavItem` 的 font-size

/** jsdom 没有字体度量，按「汉字满宽、其余 0.6em」估（Chromium 实测：六个汉字 75px）。 */
function navLabelWidth(label: string): number {
  let em = 0;
  for (const ch of label) em += /[\u3000-\u9fff\uff00-\uffef]/.test(ch) ? 1 : 0.6;
  return Math.round(em * GLYPH_PX);
}

describe("设置页左菜单与分区标题", () => {
  it("菜单文字在最窄档放得下（超了会被截成省略号）", () => {
    // 2026-09-29 的实际故障：「窗口与编辑器」六个字 75px > 70px，
    // 窄窗口下显示成「窗口与编辑…」——不报错，只是名字被吃掉一个字。
    const tooLong = settingsNavItems(false)
      .map((n) => n.label)
      .filter((label) => navLabelWidth(label) > NAV_TEXT_PX);
    expect(tooLong).toEqual([]);
  });


  it("每个菜单 label 都能在右栅找到逐字同名的标题", () => {
    const titles = sectionTitles();
    // 先确认抓到了东西，否则正则一改这条测试就空跑也不报错。
    expect(titles.size).toBeGreaterThan(8);

    const missing = settingsNavItems(false)
      .map((n) => n.label)
      .filter((label) => !titles.has(label));
    expect(missing).toEqual([]);
  });

  it("右栅的渲染顺序与 SETTINGS_SECTIONS 逐位一致", () => {
    expect(renderOrderTitles()).toEqual(SETTINGS_SECTIONS.map((s) => s.label));
  });

  it("小节锚点的 label 也能在右栅找到逐字同名的标题", () => {
    // 🔴 `SETTINGS_SUBSECTIONS` 是**不进菜单**的那批标题（远程电脑/剪贴板同步/知识库同步）。
    //     外部锚点（`openSettingsTab("general","rc")`）靠这段文字找落点，
    //     标题一改名，`findNavEl` 就永远返回 undefined ⇒ 点进来什么也不发生（连报错都没有）。
    //     上一条只管菜单项，覆盖不到它们。
    const titles = sectionTitles();
    const missing = Object.entries(SETTINGS_SUBSECTIONS)
      .filter(([, sub]) => !titles.has(sub.label))
      .map(([key, sub]) => `${key}→${sub.label}`);
    expect(missing).toEqual([]);
  });

  it("樱花主题只换图标、不换文字", () => {
    // 换了文字的话，樱花主题下点菜单就不滚了——而那只在那个主题下复现。
    const plain = settingsNavItems(false).map((n) => n.label);
    const blossom = settingsNavItems(true).map((n) => n.label);
    expect(blossom).toEqual(plain);
  });

  it("菜单 label 不能重名", () => {
    // 重名的话 `findNavEl` 的全等匹配会摸到第一个，
    // 于是其中一项永远滚到另一项那里去。
    const labels = settingsNavItems(false).map((n) => n.label);
    expect(new Set(labels).size).toBe(labels.length);
  });
});
