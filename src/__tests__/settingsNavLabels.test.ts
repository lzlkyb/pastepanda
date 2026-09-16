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
 *   右栅允许有**不入菜单**的小标题（`HotkeySection` 的「转笔记模板」、
 *   `McpTab` 的「知识库 MCP 服务」），scroll-spy 里已明写「认不出的标题直接跳过」。
 *   双向相等会把那两个合法的额外标题误报成错。
 *
 * 为何扫源码而不渲染：整个 `SettingsView` 要一大堆 Tauri 桩。
 * 而这条约束本质上就是两处源码字面的一致性，扫源码直接就能钉。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { settingsNavItems } from "@/components/settings/sections/meta";

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

describe("设置页左菜单与分区标题", () => {
  it("每个菜单 label 都能在右栅找到逐字同名的标题", () => {
    const titles = sectionTitles();
    // 先确认抓到了东西，否则正则一改这条测试就空跑也不报错。
    expect(titles.size).toBeGreaterThan(8);

    const missing = settingsNavItems(false)
      .map((n) => n.label)
      .filter((label) => !titles.has(label));
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
