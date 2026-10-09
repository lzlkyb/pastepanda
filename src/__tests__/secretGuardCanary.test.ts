import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 密钥明文守卫的金丝雀（靶子是 `tools/check_no_plaintext_secrets.sh`）。
 *
 * 2026-10-09 把 4 趟 grep 合并成 2 趟、又重挑了排除名单，两次都不能出错的性质是
 * **「改动没让任何一条判据失明」**——判据在源码里、排除名单也在源码里，
 * 光读代码看不出少了一趟。所以这里造一棵合成树，把每条判据各埋一个真会命中的金丝雀，
 * 连同一个**必须不命中**的反例（测试桩里的假 key、被排除的目录），让脚本真跑一遍。
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

/**
 * 每条用例都要真跑 bash + git + grep，还要 `git init`/`add` 一棵临时树。
 * 单跑时 1~3s，但整套并发跑时不够：2026-10-09 本机用 CI 的 `--pool=threads` 满载复现过
 * 「整仓两条」这条在默认 15s 档超时（同一条单跑 2.7s）。所以显式给一档，并把**子进程**
 * 上限压在它之内——先让 spawnSync 报错，日志里就分得开「守卫自己挂住」和「测试被 vitest 掐掉」。
 *
 * 🔴 档位按**最坏负载**取，不按平均值：同一份文件在同一台机器上量到 37s（别的会话收敛）与
 * 124s（22 个 node 进程在跑），单条平均从 ~4s 涨到 ~14s，也就是 3–4 倍的浮动。
 * 45s 的子进程档只剩 3 倍余量，一次抖动就是一条与代码无关的红——提到 120s（≈8 倍），
 * 真挂住仍然会在 2 分钟内报错，代价只挂在「守卫确实卡了」那一种情况上。
 */
const GUARD_TEST_TIMEOUT_MS = 150_000;
const GUARD_SPAWN_TIMEOUT_MS = 120_000;

const SK_PREFIX = ["sk", "-", "proj"].join("");
const VENDOR_PREFIX = ["gh", "p_", ""].join("");
const REDEEM_CONST = ["REDEEM", "_SECRE", "T"].join("");
const REDEEM_STR = ["pastepanda", "-redeem", "-v1"].join("");
// 桩：故意短（不够真 key 长度）且带 mock 字样，两条豁免任一生效都行
const MOCK_SK = ["sk", "-mock-abcdefghij"].join("");

// 排除名单**从靶子脚本里解析**，不在这里抄第二份：抄的那份会漂移，而漂移的表现正是
// 「测试在保护一个脚本里已经没有的目录」。解析不到条目＝测试自己先红。
// 🔴 只取 `EX=(` 那一段（构建产物/依赖名单，不变量是「其下 0 个被追踪文件」）。
// 脚本里还有第二份 `EX_TEST=(`：那是**测试桩豁免**，天然罩着源码（`__tests__` 自己就在里面），
// 把它一起验就等于自己造反例——我第一版这么写过，于是这条守卫在真仓库里必红。
const GUARD_SRC = fs.readFileSync(SCRIPT, "utf8");
const EX_BLOCK = /EX=\(([\s\S]*?)\)/.exec(GUARD_SRC)?.[1];
if (EX_BLOCK === undefined) throw new Error("脚本里找不到 EX=(...) 名单块，这条守卫等于没跑");
const EXCLUDED_DIRS = [...EX_BLOCK.matchAll(/--exclude-dir=([A-Za-z0-9._-]+)/g)].map(
  (m) => m[1] as string,
);

let tmp = "";

function git(args: string[]) {
  const r = spawnSync("git", ["-C", tmp, ...args], { encoding: "utf8" });
  if (r.error) throw new Error(`git ${args.join(" ")} 起不来：${r.error.message}`);
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} 失败：${r.stderr || r.stdout}`);
}

/**
 * 造一棵最小仓库树，**复用同一个 .git**：Windows 上一次 `git init` 要 1s 上下，
 * 九条用例各 init 一遍把这个文件顶到 27s（2026-10-09 实测），而用例之间真正需要的
 * 只是「工作区干净」。删掉的文件由 `git add -A` 从索引里带走，所以上一条用例
 * force-add 进索引的产物文件不会漏到下一条。
 */
function writeTree(files: Record<string, string>) {
  for (const name of fs.readdirSync(tmp)) {
    if (name === ".git") continue;
    fs.rmSync(path.join(tmp, name), { recursive: true, force: true });
  }
  for (const [rel, body] of Object.entries(files)) {
    const p = path.join(tmp, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
  }
  fs.writeFileSync(path.join(tmp, ".gitignore"), `${EXCLUDED_DIRS.map((d) => `${d}/`).join("\n")}\n`);
  fs.mkdirSync(path.join(tmp, "tools"), { recursive: true });
  fs.copyFileSync(SCRIPT, path.join(tmp, "tools", "check_no_plaintext_secrets.sh"));
  if (!fs.existsSync(path.join(tmp, ".git"))) git(["init", "-q"]);
  git(["add", "-A"]);
}

function runGuard() {
  // 不用 shell：true：Node 的 shell 模式只拼接不转义，临时路径一旦带空格就散架。
  const r = spawnSync("bash", [path.join(tmp, "tools", "check_no_plaintext_secrets.sh")], {
    encoding: "utf8",
    timeout: GUARD_SPAWN_TIMEOUT_MS,
  });
  if (r.error) throw new Error(`跑不起来 bash：${r.error.message}（守卫不能静默跳过）`);
  if (r.signal) throw new Error(`守卫子进程被 ${r.signal} 杀掉（超过 ${GUARD_SPAWN_TIMEOUT_MS}ms 没跑完）`);
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
  it(
    "干净树 → 通过（先钉住『不误报』这一侧）",
    () => {
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
    },
    GUARD_TEST_TIMEOUT_MS,
  );

  it(
    "sk- 新格式（带连字符，旧正则曾经对它无效）→ 判红",
    () => {
      writeTree({ "src-tauri/src/ai.rs": `const K = "${SK_PREFIX}-${"a".repeat(40)}";\n` });
      expect(runGuard()).toContain("❌ 发现明文 API key");
    },
    GUARD_TEST_TIMEOUT_MS,
  );

  it(
    "其它厂商 token → 判红（这一条不许被 sk- 那条吞掉）",
    () => {
      writeTree({ "src/lib/legacy.ts": `const T = "${VENDOR_PREFIX}${"B".repeat(30)}";\n` });
      const out = runGuard();
      expect(out).toContain("❌ 发现明文其它厂商 token");
      expect(out).not.toContain("❌ 发现明文 API key");
    },
    GUARD_TEST_TIMEOUT_MS,
  );

  it(
    "整仓判据一：REDEEM_SECRET 常量定义 → 判红",
    () => {
      writeTree({ "src-tauri/src/redeem.rs": `${REDEEM_CONST} = "${"k".repeat(20)}"\n` });
      expect(runGuard()).toContain("❌ 发现 REDEEM_SECRET 常量定义");
    },
    GUARD_TEST_TIMEOUT_MS,
  );

  it(
    "整仓判据二：兑换码 secret 前缀 → 判红（与常量那条各判各的）",
    () => {
      writeTree({ "docs/随便.md": `内部串是 ${REDEEM_STR}-abcdef\n` });
      expect(runGuard()).toContain("❌ 发现明文兑换码 secret");
    },
    GUARD_TEST_TIMEOUT_MS,
  );

  it(
    "测试桩与排除目录不许报红（豁免面也没扩大）",
    () => {
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
    },
    GUARD_TEST_TIMEOUT_MS,
  );
});

describe("排除名单自检是活的（不是注释里的一句好话）", () => {
  it(
    "排除目录下出现被 git 追踪的文件 → 立刻判红",
    () => {
      // 故意把产物目录里的文件 force-add 进索引——那正是「排除名单悄悄罩住源码」的形态
      writeTree({ "src-tauri/src/api.rs": `pub const BASE = 1;\n` });
      fs.mkdirSync(path.join(tmp, "src-tauri/gen"), { recursive: true });
      fs.writeFileSync(path.join(tmp, "src-tauri/gen/keep.txt"), `x\n`);
      git(["add", "-f", "src-tauri/gen/keep.txt"]);
      expect(runGuard()).toContain("❌ 排除名单失效");
    },
    GUARD_TEST_TIMEOUT_MS,
  );

  it(
    "不在仓库里跑 → 判红而不是静默跳过断言",
    () => {
      writeTree({ "src/App.tsx": `export const X = 1;\n` });
      fs.rmSync(path.join(tmp, ".git"), { recursive: true, force: true });
      const out = runGuard();
      expect(out).toContain("❌ 排除名单自检需要 git");
      expect(out).not.toContain("✅ 密钥明文守卫通过");
    },
    GUARD_TEST_TIMEOUT_MS,
  );

  it("真实仓库：当前排除名单每一个都不罩住源码（这条红了就是有人在名单里塞了源码目录）", () => {
    // 索引只读一次：这条用 JS 侧 filter，不再为每个名字起一个 grep 进程
    const tracked = spawnSync("git", ["-C", ROOT, "ls-files"], { encoding: "utf8" }).stdout.split("\n");
    expect(
      EXCLUDED_DIRS.length,
      "从脚本里解析不到 --exclude-dir 名单，这条守卫等于没跑（多半是名单写法变了）",
    ).toBeGreaterThanOrEqual(6);
    for (const name of EXCLUDED_DIRS) {
      const rx = new RegExp(`(^|/)${name.replace(/[.]/g, "\\.")}/`);
      const hits = tracked.filter((l) => rx.test(l));
      expect(hits, `--exclude-dir=${name} 下面有被追踪的文件，守卫对它失明`).toEqual([]);
    }
  });
});
