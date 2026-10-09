import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 密钥明文守卫的金丝雀（靶子是 `tools/check_no_plaintext_secrets.sh`）。
 *
 * 2026-10-09 把 4 趟 grep 合并成 2 趟、又重挑了排除名单，两次都不能出错的性质是
 * **「改动没让任何一条判据失明」**——判据在源码里、排除名单也在源码里，光读代码看不出少了一趟。
 * 所以这里造一棵合成树，把每条判据各埋一个真会命中的金丝雀，连同一个**必须不命中**的反例
 * （测试桩里的假 key、被排除的目录），让脚本在临时目录里真跑一遍。
 *
 * 合成树必须是 git 仓库：守卫现在用 `git ls-files` 自证「每个排除目录下 0 个被追踪文件」，
 * 没有 git 它按设计直接判红（断言不许静默跳过）。临时树里因此写一份 .gitignore，
 * 把排除名单里的目录名都标成 ignored——这与本仓真实状态一致。
 *
 * 🔴 本文件里**不许出现任何一条模式的完整字面量**：整仓那两趟（REDEEM_SECRET /
 * 兑换码前缀）扫的是包括 `__tests__` 在内的全仓，写全了就是自己绊自己。
 * 所有样例外都按仓库约定拼出来（`concat!` 同理——那也正是 GitHub push protection
 * 不拦拆开写法的原因）。sk- / 厂商 token 那两趟有 `__tests__` 豁免，但同样拼，
 * 免得以后豁免名单一改这里就变成假绿。
 */

const ROOT = path.resolve(__dirname, "../..");
const SCRIPT = path.join(ROOT, "tools", "check_no_plaintext_secrets.sh");

const SK_PREFIX = ["sk", "-", "proj"].join("");
const VENDOR_PREFIX = ["gh", "p_", ""].join("");
const REDEEM_CONST = ["REDEEM", "_SECRE", "T"].join("");
const REDEEM_STR = ["pastepanda", "-redeem", "-v1"].join("");
// 桩：故意短（不够真 key 长度）且带 mock 字样，两条豁免任一生效都行
const MOCK_SK = ["sk", "-mock-abcdefghij"].join("");

// 与脚本里的 EX 同步：临时树把这些目录标成 ignored，才和真实仓库「其下 0 个被追踪文件」一致
const IGNORED_DIRS = ["node_modules", "target", "target-android", "gen", ".cache", "dist", "__pycache__"];

let tmp = "";

function git(args: string[]) {
  const r = spawnSync("git", ["-C", tmp, ...args], { encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} 失败：${r.stderr || r.stdout}`);
}

/** 造一棵最小仓库树：只放脚本会看的那几个目录名。每次先清空，用例之间不互相污染。 */
function writeTree(files: Record<string, string>) {
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  fs.writeFileSync(path.join(tmp, ".gitignore"), `${IGNORED_DIRS.map((d) => `${d}/`).join("\n")}\n`);
  fs.mkdirSync(path.join(tmp, "tools"), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(tmp, "tools", "check_no_plaintext_secrets.sh"));
  git(["init", "-q"]);
  git(["add", "-A"]);
}

function runGuard() {
  // 不用 shell：true：Node 的 shell 模式只拼接不转义，临时路径一旦带空格就散架。
  const r = spawnSync("bash", [path.join(tmp, "tools", "check_no_plaintext_secrets.sh")], {
    encoding: "utf8",
  });
  if (r.error) throw new Error(`跑不起来 bash：${r.error.message}（守卫不能静默跳过）`);
  return `${r.stdout || ""}${r.stderr || ""}`;
}

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pp-secretheart-"));
  if (!fs.existsSync(SCRIPT)) throw new Error(`找不到靶子脚本：${SCRIPT}`);
});

afterAll(() => {
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true });
});

describe("密钥明文守卫的四条判据各自还活着", () => {
  it("干净树 → 通过（先钉住『不误报』这一侧）", () => {
    writeTree({
      "src-tauri/src/api.rs": `pub const BASE: &str = "https://example.com";\n`,
      "src/App.tsx": `export const X = 1;\n`,
      "tools/helper.py": `print("ok")\n`,
      "docs/note.md": `随便写点东西\n`,
    });
    const out = runGuard();
    expect(out, out).toContain("✅ 密钥明文守卫通过");
    expect(out).toContain("✓ 无明文 sk- key");
    expect(out).toContain("✓ 无明文其它厂商 token");
    expect(out).toContain("✓ 无明文 REDEEM_SECRET 常量");
    expect(out).toContain("✓ 无明文兑换码 secret");
  });

  it("sk- 新格式（带连字符，旧正则曾经对它无效）→ 判红", () => {
    writeTree({ "src-tauri/src/ai.rs": `const K = "${SK_PREFIX}-${"a".repeat(40)}";\n` });
    expect(runGuard()).toContain("❌ 发现明文 API key");
  });

  it("其它厂商 token → 判红（这一条不许被 sk- 那条吞掉）", () => {
    writeTree({ "src/lib/legacy.ts": `const T = "${VENDOR_PREFIX}${"B".repeat(30)}";\n` });
    const out = runGuard();
    expect(out).toContain("❌ 发现明文其它厂商 token");
    expect(out).not.toContain("❌ 发现明文 API key");
  });

  it("整仓两条各判各的：常量定义与兑换码前缀", () => {
    writeTree({ "src-tauri/src/redeem.rs": `${REDEEM_CONST} = "${"k".repeat(20)}"\n` });
    expect(runGuard()).toContain("❌ 发现 REDEEM_SECRET 常量定义");

    writeTree({ "docs/随便.md": `内部串是 ${REDEEM_STR}-abcdef\n` });
    expect(runGuard()).toContain("❌ 发现明文兑换码 secret");
  });

  it("测试桩与排除目录不许报红（豁免面也没扩大）", () => {
    writeTree({
      // __tests__ 整目录在 sk-/厂商 token 两趟的排除名单里：桩与「桩形状的长 key」都不该报
      "src/__tests__/stub.ts": `const fake = "${MOCK_SK}";\nconst real = "${SK_PREFIX}-${"a".repeat(40)}";\n`,
      // *.test.ts 靠文件名豁免
      "src/lib/x.test.ts": `const t = "${VENDOR_PREFIX}${"C".repeat(30)}";\n`,
      // dist 是构建产物目录（临时树里已标成 git-ignored，与真实仓库一致）：整仓那两趟排除它
      "dist/bundle.js": `const d = "${REDEEM_STR}";\n`,
    });
    const out = runGuard();
    expect(out, out).toContain("✅ 密钥明文守卫通过");
  });
});

describe("排除名单自检是活的（不是注释里的一句好话）", () => {
  it("排除目录下出现被 git 追踪的文件 → 立刻判红", () => {
    // 故意把产物目录里的文件 force-add 进索引——那正是「排除名单悄悄罩住源码」的形态
    writeTree({ "src-tauri/src/api.rs": `pub const BASE = 1;\n` });
    fs.mkdirSync(path.join(tmp, "src-tauri/gen"), { recursive: true });
    fs.writeFileSync(path.join(tmp, "src-tauri/gen/keep.txt"), `x\n`);
    git(["add", "-f", "src-tauri/gen/keep.txt"]);
    expect(runGuard()).toContain("❌ 排除名单失效");
  });

  it("不在仓库里跑 → 判红而不是静默跳过断言", () => {
    writeTree({ "src/App.tsx": `export const X = 1;\n` });
    fs.rmSync(path.join(tmp, ".git"), { recursive: true, force: true });
    const out = runGuard();
    expect(out).toContain("❌ 排除名单自检需要 git");
    expect(out).not.toContain("✅ 密钥明文守卫通过");
  });

  it("真实仓库：当前排除名单每一个都不罩住源码（这条红了就是有人在名单里塞了源码目录）", () => {
    for (const name of IGNORED_DIRS) {
      const hits = spawnSync("git", ["-C", ROOT, "ls-files"], { encoding: "utf8" }).stdout
        .split("\n")
        .filter((l) => new RegExp(`(^|/)${name.replace(/[.]/g, "\\.")}/`).test(l));
      expect(hits, `--exclude-dir=${name} 下面有被追踪的文件，守卫对它失明`).toEqual([]);
    }
  });
});
