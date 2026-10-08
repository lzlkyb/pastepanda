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

  // --max-workers / --maxWorkers 在 vitest 4.1.9 的 CLI 上不生效（实测：12 文件三档
  // 16.7–18.4s 没差别，只有 VITEST_MAX_WORKERS 环境变量翻到 31.30s）。写在这里
  // 会让人以为并发已经压下来了。
  it("不用失效的 CLI 并发参数（要临时压并发走 VITEST_MAX_WORKERS）", () => {
    for (const [name, s] of [[".husky", husky], [".githooks", plain]] as const) {
      expect(s, `${name} 用了 --max-workers，vitest 4 的 CLI 不认这个键`).not.toMatch(/--max[-_]workers/);
    }
  });
});
