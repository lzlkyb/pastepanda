import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 钉住「两份 pre-push 钩子必须等价」和「钩子里的 vitest 调用方式」。
 *
 * 为什么需要守卫：`core.hooksPath=.husky/_` ⇒ 实际生效的是 `.husky/pre-push`，
 * 而 `.githooks/pre-push` 是「不用 husky 时」照着 cp 的等价副本。两份分居两处、
 * 没有机器校验，2026-10-08 实测已经漂了：旧副本缺 `--pool=forks` 和 LIBCLANG_PATH 注入，
 * 谁按 CONTRIBUTING 里那句「cp .githooks/pre-push」装上，cargo test 会因找不到
 * libclang 直接编不过——而漂移本身平时完全不出声。
 */

const ROOT = path.resolve(__dirname, "../..");
const read = (rel: string) => fs.readFileSync(path.join(ROOT, rel), "utf8").replace(/\r\n/g, "\n");

describe("pre-push 两份钩子等价", () => {
  const husky = read(".husky/pre-push");
  const plain = read(".githooks/pre-push");

  it("内容逐字节相同（换行符归一后）", () => {
    expect(plain, "两份 pre-push 漂了：改 .husky/pre-push 必须同步 .githooks/pre-push").toBe(husky);
  });

  it("两份都注入 LIBCLANG_PATH 并跑三段（密钥守卫 + vitest + cargo）", () => {
    for (const [name, s] of [[".husky", husky], [".githooks", plain]] as const) {
      expect(s, `${name} 缺 libclang 注入，cargo test 会编不过`).toContain("LIBCLANG_PATH");
      expect(s, `${name} 少了密钥守卫那段`).toContain("check_no_plaintext_secrets.sh");
      expect(s, `${name} 少了前端测试`).toContain("npx vitest --run");
      expect(s, `${name} 少了 Rust 测试`).toContain("cargo test");
    }
  });

  // CONTRIBUTING §2.7 与 AGENTS 规则 14 现在都写「耗时由钩子自己打印」，不再抄常数。
  // 删掉计时那句就又是假话——而假话正是这份文档历史上犯过两次的错（「约 3 分钟」/「22.2 分钟」）。
  it("三段各自计时并打印（文档依赖这句输出，不许退回手抄常数）", () => {
    for (const [name, s] of [[".husky", husky], [".githooks", plain]] as const) {
      expect(s, `${name} 的计时代码没了，整轮耗时又得靠人手抄`).toContain("HOOK_START=$(date +%s)");
      for (const seg of ["密钥守卫", "前端 Vitest", "Rust cargo test"]) {
        expect(s, `${name} 少给「${seg}」这一段计时`).toContain(`mark "${seg}"`);
      }
    }
  });

  // --max-workers / --maxWorkers 在 vitest 4.1.9 的 CLI 上不生效（实测：12 文件三档
  // 16.7–18.4s 没差别，只有 VITEST_MAX_WORKERS 环境变量翻到 31.30s）。写在这里
  // 会让人以为并发已经压下来了。
  it("不用失效的 CLI 并发参数（要临时压并发走 VITEST_MAX_WORKERS）", () => {
    for (const [name, s] of [[".husky", husky], [".githooks", plain]] as const) {
      expect(s, `${name} 用了 --max-workers，vitest 4 的 CLI 不认这个键`).not.toMatch(/--max[-_]workers/);
    }
  });

  // 2026-10-09：master 开了 enforce_admins + required status checks（Rust/Frontend Tests），
  // 「全绿才可合」的裁判已经从本地钩子搬到 GitHub 那边了。钩子再跑一遍全量等于同一套测试付两遍
  // （本地 566s + CI 12m），而它的副作用是别人的在途文件在给本次 push 判分。
  // 于是按被推的目标分档：只有推 master 或 tag 才付全量。
  // 这段断言钉的是「分档真的存在且顺序对」，删掉任何一句都会让文档变成假话。
  it("按被推目标分档，全量只在推 master / tag 时跑", () => {
    for (const [name, s] of [[".husky", husky], [".githooks", plain]] as const) {
      const at = (needle: string) => {
        const i = s.indexOf(needle);
        expect(i, `${name} 缺这句：${needle}`).toBeGreaterThan(-1);
        return i;
      };
      // 判档器是收口的纯函数，不是钩子里现写的一段 case
      const decide = at("prePushTier.mjs");
      // 失败要往重的方向掉：GUI 客户端不给 stdin 时读不到 ref，绝不能因此跳过全量
      const failSafe = at('MODE="full"');
      expect(failSafe, `${name} 的 MODE 初值不是 full（读不到 ref 时会静默走轻档）`).toBeLessThan(decide);
      // 顺序必须是：判档 → 轻档也跑的守卫 → 全量闸 → vitest/cargo
      const secretGuard = at("check_no_plaintext_secrets.sh");
      const gate = at('if [ "$MODE" = "full" ]');
      const vitest = at("npx vitest --run");
      const cargo = at("cd src-tauri && cargo test");
      expect(secretGuard, `${name} 的密钥守卫被关进全量闸里了，轻档会跳过`).toBeGreaterThan(decide);
      expect(gate, `${name} 没有全量闸`).toBeGreaterThan(secretGuard);
      expect(vitest, `${name} 的 vitest 不在全量闸之后`).toBeGreaterThan(gate);
      expect(cargo, `${name} 的 cargo test 不在全量闸之后`).toBeGreaterThan(vitest);
      // tsc 必须待在闸外：CI 的 frontend-test 只有 `npx vitest run`，而 vitest 只剥类型不校验，
      // 把它关进 full 就等于「特性分支的 push 谁都不查类型」——只有 release 构建才会第一次发现。
      const tsc = at("npx tsc --noEmit");
      expect(tsc, `${name} 的 tsc 被关进全量闸里了，轻档就不查类型`).toBeLessThan(gate);
      expect(tsc, `${name} 的 tsc 跑在判档之前（读不到 stdin 时无从知道该不该跑）`).toBeGreaterThan(decide);
    }
  });
});
