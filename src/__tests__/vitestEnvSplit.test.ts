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
    execSync(`git ls-files "*.test.ts" "*.test.tsx" "*.spec.ts" "*.spec.tsx"`, {
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

  it("setupFiles 只挂在两个 project 上，顶层一份都不留", () => {
    // extends:true 走 mergeConfig，数组是**拼接**：顶层再留一份，jsdom 侧的共享 setup
    // 就会跑两遍；只查文本形态，运行时是否真装上了由 asyncUtilTimeout.test.tsx 实测。
    expect(CONFIG.match(/setupFiles:/g)?.length, "setupFiles 出现次数变了（应为两个 project 各一处）").toBe(2);
    expect(CONFIG).toContain("setupFiles: [SETUP_SHARED]");
    expect(CONFIG).toContain("setupFiles: [SETUP_SHARED, SETUP_DOM]");
    const beforeProjects = CONFIG.slice(0, CONFIG.indexOf("projects: ["));
    expect(beforeProjects, "顶层 test 块里又出现了 setupFiles，jsdom 侧会重复执行").not.toContain("setupFiles:");
    expect(fs.existsSync(path.join(ROOT, "src/test-setup.dom.ts")), "jsdom 专属 setup 文件不在了").toBe(true);
  });

  // 并发上限写进了 vitest 不认的键，表现和没写一样：机器照样被打成页抖动、
  // worker 启动闸照样超时判红，而配置文件看着是「已封顶」。
  // 2026-10-08 就踩过：`poolOptions.forks.maxForks` 在 vitest 4 里是死键
  // （只打一条 deprecate 警告然后整块忽略），并发一直是 cpus-1。
  it("并发上限用的是本机安装的 vitest 真正认识的键", () => {
    // 只认「键名+冒号」这种配置形态：注释里会提到 poolOptions 这个词本身。
    expect(CONFIG, "并发封顶键没了（maxWorkers 被删）").toMatch(/\n\s*maxWorkers:/);
    expect(CONFIG, "又用回 vitest 4 的死键 poolOptions").not.toContain("poolOptions:");
    expect(CONFIG, "内存档变了：改这里前先在本机实测，别拍数字").toContain("const MAX_WORKERS = 10;");

    // 不靠记忆断言版本行为：直接扫安装副本里实际存在的键名。
    const dist = path.join(ROOT, "node_modules/vitest/dist");
    let hasMaxWorkers = false;
    let hasMaxForks = false;
    const walk = (dir: string) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        if (hasMaxWorkers && hasMaxForks) return;
        const p = path.join(dir, e.name);
        if (e.isDirectory()) walk(p);
        else if (e.name.endsWith(".js")) {
          const s = fs.readFileSync(p, "utf8");
          if (s.includes("maxWorkers")) hasMaxWorkers = true;
          if (s.includes("maxForks")) hasMaxForks = true;
        }
      }
    };
    walk(dist);
    expect(hasMaxWorkers, "安装的 vitest 里没有 maxWorkers，配置里的封顶是死的").toBe(true);
    expect(hasMaxForks, "安装的 vitest 支持 maxForks 了，本条守卫和配置的口径都该跟着改").toBe(false);
  });

  // node 档的测试碰到「只有 jsdom / 新版 Node 才有的全局」时，本机绿灯不代表 CI 绿灯：
  // CI 是 Node 20（test.yml 的 node-version），本机是 24，而 `navigator` 是 Node 21+ 才有的
  // 全局。2026-10-09 就栽过一次——mcpConnectActions.test.ts 里 defineProperty(navigator,…)
  // 本机全绿、CI 三条连片红。DOM_NEEDED_TS 那份清单是**在本机跑出来的实测结果**，
  // 它对「版本差」天然瞎，所以要有一条与运行环境无关的静态网。
  it("node 档的测试不引用 jsdom/Node21+ 才有的全局（按成员访问算）", () => {
    const BANNED = /\bnavigator\s*[.[]/;
    const inList = new Set(list);
    const hits = [...trackedTests()]
      .filter((f) => f.endsWith(".ts") && !inList.has(f))
      .filter((f) => BANNED.test(fs.readFileSync(path.join(ROOT, f), "utf8")));
    expect(hits, `这些 node 档测试直接访问了 navigator 的成员: ${hits.join(", ")}`).toEqual([]);
  });
});
