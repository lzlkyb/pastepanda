import { execSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 钉住 vitest.config.ts「按环境拆 project」这套机制的几条不变量。
 *
 * 为什么需要守卫：DOM_NEEDED_TS 是一份五十多条的路径清单，它坏了不出声——
 * ① 路径写错/文件改名 ⇒ 该文件悄悄掉回 node 环境，靠 DOM 的分支不再被执行；
 * ② 清单里混进 .test.tsx ⇒ 同一文件被两个 project 各跑一遍（用例数虚高）；
 * ③ include 通配被改窄 ⇒ 落在 src/ 之外的新测试两个 project 都不匹配 = 永不执行；
 * ④ test-setup.ts 恢复成无条件摸 window ⇒ node project 下 setup 自身抛错。
 * 这四种都是「全绿但保护已失效」，只能靠守卫自己判红。
 */

const ROOT = path.resolve(__dirname, "../..");
const CONFIG = fs.readFileSync(path.join(ROOT, "vitest.config.ts"), "utf8");

function domNeeded(): string[] {
  const m = CONFIG.match(/const DOM_NEEDED_TS: string\[\] = \[([\s\S]*?)\n\];/);
  expect(m, "vitest.config.ts 里 DOM_NEEDED_TS 的声明形态变了，守卫解析不到").toBeTruthy();
  return [...(m as RegExpMatchArray)[1].matchAll(/"([^"]+)"/g)].map((x) => x[1]);
}

function trackedTests(): Set<string> {
  return new Set(
    execSync(`git ls-files "*.test.ts" "*.test.tsx" "*.spec.ts" "*.spec.ts"`, {
      cwd: ROOT,
      encoding: "utf8",
    })
      .trim()
      .split(/\r?\n/)
      .filter(Boolean)
  );
}

describe("vitest 环境拆档守卫", () => {
  const list = domNeeded();

  it("清单里没有失效路径、没有重复，且每条都受版本管理", () => {
    const tracked = trackedTests();
    const missing = list.filter((f) => !fs.existsSync(path.join(ROOT, f)));
    expect(missing, `DOM_NEEDED_TS 里这些文件已不存在: ${missing.join(", ")}`).toEqual([]);
    expect(list.length, "DOM_NEEDED_TS 有重复条目").toBe(new Set(list).size);
    const untracked = list.filter((f) => !tracked.has(f));
    expect(untracked, `这些文件只在本地存在，CI 上不会被收集: ${untracked.join(", ")}`).toEqual([]);
  });

  it("清单只收纯 .ts 测试（.tsx 已由通配归入 jsdom，收进来就是双跑）", () => {
    const wrong = list.filter((f) => !f.endsWith(".ts"));
    expect(wrong, `清单里非 .ts 条目: ${wrong.join(", ")}`).toEqual([]);
  });

  it("两个 project 的 include 通配未被改窄（否则新测试会两边都不沾）", () => {
    expect(CONFIG).toContain('include: ["**/*.test.ts", "**/*.spec.ts"]');
    expect(CONFIG).toContain('include: ["**/*.test.tsx", "**/*.spec.tsx", ...DOM_NEEDED_TS]');
  });

  it("test-setup 摸 window 之前先判环境（node project 的前置条件）", () => {
    const setup = fs.readFileSync(path.join(ROOT, "src/test-setup.ts"), "utf8");
    const guard = setup.indexOf('typeof window !== "undefined"');
    const touch = setup.indexOf("Object.defineProperty(window");
    expect(guard, "test-setup.ts 没有 typeof window 判空，node project 下 setup 会整体抛错").toBeGreaterThan(-1);
    expect(touch, "找不到 matchMedia 打桩那一行（守卫要比较的位置没了）").toBeGreaterThan(-1);
    expect(touch > guard, "Object.defineProperty(window…) 又跑到了 typeof 判空之前").toBe(true);
  });
});
