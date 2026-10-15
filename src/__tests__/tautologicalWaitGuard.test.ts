import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 钉住「等永真条件」的等待写法不再回潮（Issue #3 的静态那一半）。
 *
 * 运行时那一半在 src/__tests__/slowFetchInjection.test.tsx：慢取数注入把 mock 的
 * 异步返回推到真实宏任务，让「首帧即成立的判据 + 随后直接读结果」必然判红。
 * 但注入只在 PASTEPANDA_SLOW_MOCK=1 时才装载，平时不跑 ⇒ 本文件补两条不会失效的断言：
 *   ① 静态拦住「用微任务 flush 当就绪信号」——它假定取数一定在微任务里落地，正是这轮
 *      注入扫描判红的那批用例的共同成因（清单与修法见 docs/测试等待写法-全树扫描-2026-10-11.md）；
 *   ② 钉住注入本身还挂在配置上——被人摘掉时这里判红，而不是让扫描悄悄变成空转。
 */

const ROOT = path.resolve(__dirname, "../..");
const SKIP_DIRS = new Set(["node_modules", "dist", ".cache", "design", "target", "target-android", "target-macos", "target-macos-intel", "src-tauri"]);

const read = (abs: string) => fs.readFileSync(abs, "utf8").replace(/\r\n/g, "\n");

// 违规形态：act(async () => { await Promise.resolve(); ... }) 里除了让渡微任务什么都没等。
// 取数一旦不在微任务落地（真机器上被别的宏任务挤到后面），紧随其后的断言读到的就是空态首帧。
// 正解是用 waitFor/findBy* 等一条**只有真数据才成立**的判据。
const ACT_BLOCK = /act\(\s*async\s*\(\)\s*=>\s*\{([^{}]*)\}\s*\)/g;

function findMicrotaskFlushes(source: string): number[] {
  const lines: number[] = [];
  for (const match of source.matchAll(ACT_BLOCK)) {
    const body = match[1];
    const awaits = body.split("await ").length - 1;
    const microtaskYields = body.split("Promise.resolve()").length - 1;
    if (awaits === 0 || awaits !== microtaskYields) continue;
    // 混了计时器推进的（假计时器文件里的正当写法）不算。
    if (/advance|setTimeout|tick|sleep/i.test(body)) continue;
    lines.push(source.slice(0, match.index).split("\n").length);
  }
  return lines;
}

// 豁免标记：写在违规那一行的**上一行**，形如
//   // waitguard:allow: 这条没有任何取数，flush 只是让 effect 跑完
// 为什么按标记而不按「文件名单」：名单是整文件豁免，改一条等于放开全文件的同类写法；
// 又为什么不按行号：行号会随着上方任何编辑漂移，漂移后的豁免等于挂到别的代码上。
// 标记必须**带理由**且**紧挨违规行**，孤立/过期的标记同样判红（见第 3 条）。
const ALLOW_MARK = /^\s*\/\/\s*waitguard:allow:\s*(\S.*)$/;

/** 返回 {违规行号, 该行是否被上一行的豁免标记盖住} */
function scanMicrotaskFlushes(source: string): { line: number; allowed: boolean }[] {
  const lines = source.split("\n");
  const out: { line: number; allowed: boolean }[] = [];
  for (const hit of findMicrotaskFlushes(source)) {
    // hit 是 `act(` 所在行号（1 基）；豁免标记写在它上一行。
    const marker = lines[hit - 2]?.match(ALLOW_MARK);
    out.push({ line: hit, allowed: !!marker });
  }
  return out;
}

/** 文件里所有自称为豁免的标记行号（用来抓「过期豁免」：标记还在，违规已被修掉）。 */
function markerLines(source: string): number[] {
  const out: number[] = [];
  source.split("\n").forEach((line, index) => {
    if (ALLOW_MARK.test(line)) out.push(index + 1);
  });
  return out;
}

function collectTestFiles(dir: string, out: string[] = []): string[] {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) {
      if (SKIP_DIRS.has(entry.name) || entry.name.startsWith(".")) continue;
      collectTestFiles(path.join(dir, entry.name), out);
    } else if (/\.test\.[tm]sx?$/.test(entry.name) || /\.spec\.[tm]sx?$/.test(entry.name)) {
      out.push(path.join(dir, entry.name));
    }
  }
  return out;
}

describe("等待写法守卫", () => {
  it("判据能咬人：微任务 flush 被认定违规，等真数据/推计时器的写法不被误报", () => {
    const bad = "const flush = () => act(async () => {\n  await Promise.resolve();\n  await Promise.resolve();\n});";
    expect(findMicrotaskFlushes(bad), "detector 认不出「只让渡微任务」=守卫是死的").toEqual([1]);

    // 这几类是合法用法，误报会让人学会忽略这条守卫的报错。
    for (const good of [
      "await act(async () => {\n  await saveNote(\"n-1\");\n});",
      "await act(async () => {\n  await vi.advanceTimersByTimeAsync(500);\n});",
      "await waitFor(() => expect(result.current.ready).toBe(true));",
      "act(() => {\n  fireEvent.click(btn);\n});",
    ]) {
      expect(findMicrotaskFlushes(good), `误报：${good}`).toEqual([]);
    }
  });

  it("豁免标记：紧挨违规行才生效，孤立标记（违规已修掉）照样判红", () => {
    const withMark = "// waitguard:allow: 本用例零取数\nawait act(async () => {\n  await Promise.resolve();\n});";
    expect(scanMicrotaskFlushes(withMark)).toEqual([{ line: 2, allowed: true }]);

    // 标记与违规行之间隔了一行 ⇒ 不算盖住（漂移的标记不能继续豁免）。
    const drifted = "// waitguard:allow: 隔一行\n\nawait act(async () => {\n  await Promise.resolve();\n});";
    expect(scanMicrotaskFlushes(drifted)).toEqual([{ line: 3, allowed: false }]);

    // 没有理由的标记不成立（`allow:` 后面空着）。
    expect(scanMicrotaskFlushes("// waitguard:allow:\nawait act(async () => {\n  await Promise.resolve();\n});")).toEqual([{ line: 2, allowed: false }]);

    // 过期取证：文件里只剩标记、违规行已删 ⇒ markerLines 与豁免对不上，全仓扫描那条判红。
    const stale = "// waitguard:allow: 已被修掉的写法\nconst x = 1;\n";
    expect(markerLines(stale)).toEqual([1]);
    expect(scanMicrotaskFlushes(stale).filter((x) => x.allowed)).toEqual([]);
  });

  it("全仓测试文件不再新增「微任务 flush 当就绪信号」", () => {
    const hits: string[] = [];
    const staleMarks: string[] = [];
    const self = path.resolve(__dirname, "tautologicalWaitGuard.test.ts");
    for (const file of collectTestFiles(ROOT)) {
      // 本文件第 1/2 条里存着 detector 的反例样本，不参与全仓扫描。
      if (path.resolve(file) === self) continue;
      const source = read(file);
      const rel = path.relative(ROOT, file).replace(/\\/g, "/");
      const found = scanMicrotaskFlushes(source);
      const unallowed = found.filter((x) => !x.allowed);
      if (unallowed.length) hits.push(`${rel}:${unallowed.map((x) => x.line).join(",")}`);
      // 每条自称为豁免的标记都必须正好盖住一条违规行，否则它就是过期的（写法已修掉，
      // 留着只会让人以为这个文件还有豁免）。
      const exempted = found.filter((x) => x.allowed).map((x) => x.line - 1);
      const stale = markerLines(source).filter((line) => !exempted.includes(line));
      if (stale.length) staleMarks.push(`${rel}:${stale.join(",")}`);
    }
    expect(hits, `这些地方把微任务让渡当成「数据已落地」，慢取数下会读到空态首帧：\n${hits.join("\n")}`).toEqual([]);
    expect(staleMarks, `这些 waitguard:allow 标记已经盖不住任何违规=写法修掉了请删标记：\n${staleMarks.join("\n")}`).toEqual([]);
  });

  // 注入如果被摘掉挂载点，扫描模式会退化成「照跑不误、一条也暴露不出来」的空转。
  it("慢取数注入仍挂在两个 project 的 setupFiles 上", () => {
    const config = read(path.join(ROOT, "vitest.config.ts"));
    expect(config, "SETUP_SLOW 常量没了").toContain("PASTEPANDA_SLOW_MOCK");
    expect(config, "node project 没挂注入，纯逻辑侧的永真等待扫不出来").toMatch(/setupFiles: \[SETUP_SHARED, \.\.\.SETUP_SLOW\]/);
    expect(config, "jsdom project 没挂注入，组件侧的永真等待扫不出来").toMatch(/setupFiles: \[SETUP_SHARED, \.\.\.SETUP_SLOW, SETUP_DOM\]/);
    expect(fs.existsSync(path.join(ROOT, "src/test-setup.slow-mock.ts")), "注入实现文件被删了").toBe(true);
  });

  // 假计时器把 globalThis.setTimeout 换掉后，被推迟的取数永远不落地 ⇒ 整批超时，
  // 那是工具自己的假红而不是被测代码的问题，所以真实计时器必须在装载时就留在闭包里。
  it("注入捕获真实 setTimeout 引用（否则 vi.useFakeTimers 的文件会整批假红）", () => {
    const setup = read(path.join(ROOT, "src/test-setup.slow-mock.ts"));
    expect(setup, "deferToMacrotask 又直接用 setTimeout 了").toContain("const realSetTimeout = globalThis.setTimeout");
    expect(setup, "宏任务档没了，微任务落地等于没注入").toContain("realSetTimeout(");
  });
});
