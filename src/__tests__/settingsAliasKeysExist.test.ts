/**
 * 别名表的键必须还能在设置页源码里找到原文。
 *
 * 🔴 键是**设置行标题的原文**（`settings-aliases.ts` 文件头写了这条约定）。
 * 一旦某行改名而键没跟着改，那行的别名**静默失效**——搜索它只会剩描述里的巧合命中，
 * 而界面看起来一切正常。真代码里只有 `warnStaleAliasKeys` 在 **dev 构建**里 console.warn，
 * 而 WebView 的控制台没人天天看，等于没有守卫。
 *
 * 2026-09-29 分区重排把十几个设置行**跨文件搬运**（「通用」拆成外观/复制与粘贴/系统与编辑/截图与栈），
 * 正是最容易顺手改标题的一次，所以补这条。
 *
 * 判据用「源码里找得到这段文字」而不是「解析出全部标题再比对」：
 * 后者要处理 `label=` 属性、多行 JSX 文本、`<HelpTooltip>` 混排好几种写法，
 * 解析漏一种就会误报；而改名这个故障模式用子串就能抓到。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { SETTING_ALIASES } from "@/lib/settings-aliases";

const ROOT = join(process.cwd(), "src", "components", "settings");

function sourceText(dir: string, acc: string[] = []): string[] {
  for (const f of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, f.name);
    if (f.isDirectory()) sourceText(p, acc);
    else if (f.name.endsWith(".tsx")) acc.push(readFileSync(p, "utf8"));
  }
  return acc;
}

describe("设置项别名表", () => {
  it("每个键都能在设置页源码里找到同名文字（改过标题没改键 = 别名静默失效）", () => {
    const all = sourceText(ROOT).join("\n");
    const stale = Object.keys(SETTING_ALIASES).filter((k) => !all.includes(k));
    expect(stale).toEqual([]);
  });

  it("别名表不是空的（抓空了上一条就是空跑）", () => {
    expect(Object.keys(SETTING_ALIASES).length).toBeGreaterThan(30);
  });
});
