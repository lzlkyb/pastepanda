/**
 * 守卫：能力档的「能不能动键鼠」判定必须只有一份实现（规则 #11.1）。
 *
 * 两条各管一半：
 * 1. 纯判据 —— 未知值必须落到保守的一侧（只看）。历史行的 `capability` 是
 *    磁盘上的 `string`，没有类型系统兜底。
 * 2. 全仓扫描 —— 「有人新写一处 `=== "control"`」才是这条缺陷的复发方式。
 *    判据本体允许出现该字面量；`RcA2*` 是本轮禁区；两个无人值守面板的
 *    `cap` 是本地 `useState<"control" | "view">`（第三档真出现时 TS 会报错，
 *    而它们比较的是自己刚 set 的值，不是外来值），所以也在名单内。
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe, expect, it } from "vitest";
import { rcCanControl, rcCapShort, rcCapTone } from "./rcCapability";

describe("rcCanControl / rcCapTone / rcCapShort", () => {
  it("只有明确的 control 才算可控", () => {
    expect(rcCanControl("control")).toBe(true);
    expect(rcCanControl("view")).toBe(false);
  });

  it("外来值一律按更保守的一侧，不许被当成可控", () => {
    for (const junk of ["", "Control", "CONTROL", "clipboard", "control ", undefined, null]) {
      expect(rcCanControl(junk as never)).toBe(false);
      expect(rcCapTone(junk as never)).toBe("view");
      expect(rcCapShort(junk as never)).toBe("只看");
    }
  });

  it("rcCapTone 的产物仍是两档联合类型能用到的字面量", () => {
    expect(rcCapTone("control")).toBe("control");
    expect(rcCapTone("view")).toBe("view");
  });
});

describe("全仓不许再写第四处 `=== \"control\"` 判定", () => {
  const ROOT = join(process.cwd(), "src");

  /** 放行名单与**为什么**它不需要走判据（同 dialogEscapeLayering 的口径：写理由，不写名字了事）。 */
  const ALLOWED = [
    // 判据本体。
    "lib/rcCapability.ts",
    // 本地 useState<"control" | "view"> 的 radio `checked` 与承诺句：比的是自己刚 set 的值，
    // 不是外来值；第三档出现时 TS 直接报错，这处不会静默走错。
    "components/settings/RcUnoGeneratePane.tsx",
    "components/settings/RcUnoPassPane.tsx",
  ];

  /**
   * 本轮禁区（AGENTS 记忆：`RcA2*` 不动）整片按名字放行，**不逐个登记**：
   * 那批文件此刻可能在工作树里，也可能不在（它们还没提交），写死单个路径会让这条
   * 守卫在干净检出上直接读不到文件而失败。
   */
  const FORBIDDEN_ZONE = /^components\/rc\/RcA2/;

  // 只认「能力档」的比较式：`"control"` 这个字面量在栈浮标那里是**锚点类型**
  // （`anchorKind`，见 stack/types.ts），跟远程能力没关系，不该被这条扫到。
  const RE = /(capability|cap)\s*[!=]==\s*"control"/;

  function walk(dir: string, out: string[] = []): string[] {
    for (const e of readdirSync(dir, { withFileTypes: true })) {
      if (e.name === "node_modules") continue;
      const p = join(dir, e.name);
      if (e.isDirectory()) walk(p, out);
      else if (/\.tsx?$/.test(e.name) && !e.name.includes(".test.")) out.push(p);
    }
    return out;
  }

  it("比较式只能出现在判据本体与名单内", () => {
    const files = walk(ROOT);
    const hits: string[] = [];
    for (const file of files) {
      const rel = relative(ROOT, file).replace(/\\/g, "/");
      if (ALLOWED.includes(rel) || FORBIDDEN_ZONE.test(rel)) continue;
      if (RE.test(readFileSync(file, "utf8"))) hits.push(rel);
    }
    expect(hits).toEqual([]);
  });

  it("名单不留死条目（谁被改走了就删掉谁）", () => {
    const stale = ALLOWED.filter(
      (rel) => !RE.test(readFileSync(join(ROOT, rel.replace(/\//g, "\\")), "utf8"))
    );
    expect(stale).toEqual([]);
  });
});
