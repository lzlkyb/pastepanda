import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  DEFAULT_RETRY_WAITS,
  MANIFEST_BRANCH,
  MANIFEST_DIR,
  addArgs,
  githubGitUrl,
  planFiles,
  publishManifestBranch,
  pushArgs,
  sanitizeRemote,
  verifyVerdict,
} from "./publish-manifest-branch.mjs";

/**
 * manifest 出境路径的口径守卫（2026-10-10 定性之后新增）。
 *
 * 元凶：Gitee 的「仓库镜像管理」同步 GitHub 的**整个分支集合**，并且会删除上游没有的分支
 * ⇒ 手工建在 Gitee 上的孤儿分支 `releases` 每推一次 GitHub 就被剪一次，客户端第 1 更新源跟着 404。
 * 修法是把这条分支建到 GitHub 上，让镜像替我们搬运。于是这个文件成了唯一的 push 出口，
 * 下面这些形态必须长期成立——它们一旦翻回去，通道会以「发版成功但第 1 源 404」的形式复发。
 */

describe("push 只许 fast-forward", () => {
  it("参数里没有任何 force / 改写历史的形态", () => {
    const args = pushArgs();
    expect(args).toEqual(["push", "origin", MANIFEST_BRANCH]);
    for (const a of args) {
      expect(a, "非 FF 的分支更新会被镜像同步拒绝，Gitee 那份就停在旧 sha 上 ⇒ 客户端读到旧 manifest（比 404 更毒）").not.toMatch(
        /^(-f|--force|--force-with-lease)$/,
      );
    }
  });

  it("远端地址走令牌 + GitHub，不是 Gitee", () => {
    const url = githubGitUrl("lzlkyb/pastepanda", "TOK");
    expect(url).toBe("https://x-access-token:TOK@github.com/lzlkyb/pastepanda.git");
    expect(url).not.toContain("gitee.com");
  });

  it("令牌不许出现在可打印的文本里", () => {
    const line = sanitizeRemote('cloning "https://x-access-token:SECRET@github.com/a/b.git"');
    expect(line).not.toContain("SECRET");
    expect(sanitizeRemote("https://oauth2:ABCDEF@gitee.com/x/y.git push")).not.toContain("ABCDEF");
    // 没有凭据的 URL 不能被误伤
    expect(sanitizeRemote("https://gitee.com/raw/releases/latest/a.json")).toBe("https://gitee.com/raw/releases/latest/a.json");
  });
});

describe("latest/ 里住着两份 manifest，谁也不许整目录清空", () => {
  it("add 只点名自己那几份，不用 -A", () => {
    const args = addArgs(["updater-gitee.json"]);
    expect(args).toEqual(["add", "--", `${MANIFEST_DIR}/updater-gitee.json`]);
    expect(args).not.toContain("-A");
    expect(args.join(" "), "-A latest 会把别人的 manifest 的删除也一起提交").not.toMatch(/-A\s+latest/);
  });

  it("文件名形态不对就拒绝，别把 dist/ 里的东西原样塞进分支", () => {
    expect(() => planFiles(["dist/updater-gitee.json"])).not.toThrow();
    expect(() => planFiles(["dist/../../etc/passwd"])).toThrow(/形态/);
    expect(() => planFiles(["dist/setup.exe"])).toThrow(/形态/);
    expect(() => planFiles([])).toThrow(/没有指定/);
  });
});

describe("三段验证的判定", () => {
  const P = "aaaa";
  const base = { pushedSha: P, expected: { "updater-gitee.json": "7.2.11" } };

  it("GitHub 自己没跟上 → github（push 没生效，跟 Gitee 无关）", () => {
    expect(verifyVerdict({ ...base, ghSha: "bbbb", giteeSha: P, versions: { "updater-gitee.json": "7.2.11" } })).toBe("github");
  });

  it("GitHub 到位、Gitee 分支还停在旧 sha → mirror（镜像没搬）", () => {
    expect(verifyVerdict({ ...base, ghSha: P, giteeSha: "bbbb", versions: {} })).toBe("mirror");
    expect(verifyVerdict({ ...base, ghSha: P, giteeSha: null, versions: {} })).toBe("mirror");
  });

  it("分支 sha 一致但 raw 还回旧内容/读不到 → cdn（边缘节点传播，不是文件缺失）", () => {
    expect(verifyVerdict({ ...base, ghSha: P, giteeSha: P, versions: { "updater-gitee.json": "7.2.10" } })).toBe("cdn");
    expect(verifyVerdict({ ...base, ghSha: P, giteeSha: P, versions: { "updater-gitee.json": null } })).toBe("cdn");
    expect(verifyVerdict({ ...base, ghSha: P, giteeSha: P, versions: {} })).toBe("cdn");
  });

  it("三段全绿才叫 ok", () => {
    expect(verifyVerdict({ ...base, ghSha: P, giteeSha: P, versions: { "updater-gitee.json": "7.2.11" } })).toBe("ok");
  });

  it("等待档总时长 ≥ 实测最坏传播（4 分钟），否则会把成功判成失败", () => {
    const total = DEFAULT_RETRY_WAITS.reduce((a, b) => a + b, 0);
    expect(total, `重试只等 ${total}s，raw 传播实测见过 4 分钟 ⇒ 会把已经推好的通道报成失败`).toBeGreaterThanOrEqual(240);
  });
});

/**
 * 端到端彩排：上面的守卫只断言 argv 形态，这一段真的建仓库、真的 push。
 *
 * 为什么值得付这点 git 开销：CI 的前端/ Rust 两道闸都碰不到「对 GitHub releases 分支的 FF push」
 * 本身，dry-run 又在 clone 之前就 return——于是这个模块最关键的两条红线（不 force、不清空对端）
 * 只剩正则守卫。两条反例（`addArgs`→`-A`、去掉 `reset --hard`）在下面都会真变红，不是「形状像对」。
 */
describe("出境路径端到端（本地 bare 仓库）", () => {
  const WHO = { email: "e2e@pastepanda.local", name: "e2e" };
  let tmp: string;

  function git(args: string[], cwd?: string) {
    const r = spawnSync("git", args, { cwd, encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${args.join(" ")} 失败：\n${r.stdout}${r.stderr}`);
    return r.stdout.trim();
  }

  function writeJson(dir: string, name: string, body: unknown) {
    fs.mkdirSync(dir, { recursive: true });
    const p = path.join(dir, name);
    fs.writeFileSync(p, JSON.stringify(body, null, 2) + "\n", "utf8");
    return p;
  }

  /** 建一个 bare 仓库，只在 `branch` 上放 files 这些内容。 */
  function seedBare(label: string, branch: string, files: Record<string, string>) {
    const bare = path.join(tmp, `${label}.git`);
    git(["init", "-q", "--bare", `--initial-branch=${branch}`, bare]);
    const work = path.join(tmp, `${label}-work`);
    git(["init", "-q", "--initial-branch", branch, work]);
    for (const [rel, content] of Object.entries(files)) {
      const abs = path.join(work, rel);
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, content, "utf8");
    }
    git(["add", "-A"], work);
    git(["-c", `user.email=${WHO.email}`, "-c", `user.name=${WHO.name}`, "-c", "commit.gpgsign=false", "commit", "-q", "-m", "seed"], work);
    git(["push", "-q", bare, `HEAD:refs/heads/${branch}`], work);
    return bare;
  }

  beforeAll(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pp-manifest-egress-"));
  });

  afterAll(() => {
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it(
    "分支已存在：FF 落地、父提交就是旧 tip、对端 manifest 一个字节没动",
    () => {
      const bare = seedBare("has-branch", MANIFEST_BRANCH, {
        "latest/updater-gitee.json": JSON.stringify({ version: "7.2.10", note: "old-desktop" }) + "\n",
        "latest/apk-update-gitee.json": JSON.stringify({ version: "7.2.10", url: "apk-old" }) + "\n",
        "README.md": "分支说明\n",
      });
      const sha0 = git(["--git-dir", bare, "rev-parse", MANIFEST_BRANCH]);
      const src = writeJson(path.join(tmp, "out1"), "updater-gitee.json", { version: "7.2.11", note: "new-desktop" });

      const res = publishManifestBranch({ repo: "e2e/fixture", token: "", remote: bare, files: [src], identity: WHO });
      expect(res.pushed).toBe(true);

      expect(git(["--git-dir", bare, "rev-parse", MANIFEST_BRANCH]), "push 没生效").toBe(res.sha);
      expect(git(["--git-dir", bare, "rev-parse", `${MANIFEST_BRANCH}^`]), "新提交的父不是旧 tip ⇒ 这不是 FF").toBe(sha0);
      expect(
        JSON.parse(git(["--git-dir", bare, "show", `${MANIFEST_BRANCH}:latest/updater-gitee.json`])).version,
      ).toBe("7.2.11");
      expect(
        JSON.parse(git(["--git-dir", bare, "show", `${MANIFEST_BRANCH}:latest/apk-update-gitee.json`])).url,
        "手机端第 1 更新源被这次桌面发版改掉了",
      ).toBe("apk-old");
      // 目录清单也是断言：多出一份/少一份都会红（`-A` 反例正是靠它抓住）
      expect(
        git(["--git-dir", bare, "ls-tree", "-r", "--name-only", MANIFEST_BRANCH])
          .split(/\r?\n/)
          .sort(),
      ).toEqual(
        ["latest/apk-update-gitee.json", "latest/updater-gitee.json", "README.md"].sort(),
      );
    },
    120_000,
  );

  it(
    "分支查无：从默认分支建孤儿分支，latest/ 外一份源码都不许跟进来",
    () => {
      const bare = seedBare("no-branch", "main", {
        "src/app.ts": "export const x = 1;\n",
        "package.json": "{}\n",
      });
      const verify = spawnSync("git", ["--git-dir", bare, "rev-parse", "--verify", `refs/heads/${MANIFEST_BRANCH}`], {
        encoding: "utf8",
      });
      expect(verify.status, "fixture 本该只有 main，releases 查无才走重建臂").not.toBe(0);
      const src = writeJson(path.join(tmp, "out2"), "apk-update-gitee.json", { version: "7.2.11", url: "apk-new" });

      const res = publishManifestBranch({ repo: "e2e/fixture", token: "", remote: bare, files: [src], identity: WHO });
      expect(res.pushed).toBe(true);
      // 孤儿分支重建的正确形态：只有一笔提交，且树里只有我们要发的那份文件。
      // 去掉 prepareWorktree 里的 reset --hard，这条会红——源码树会整份跟进 releases 分支。
      expect(git(["--git-dir", bare, "rev-list", "--count", MANIFEST_BRANCH])).toBe("1");
      expect(git(["--git-dir", bare, "ls-tree", "-r", "--name-only", MANIFEST_BRANCH])).toBe(
        "latest/apk-update-gitee.json",
      );
      expect(git(["--git-dir", bare, "rev-parse", "main"]), "重建臂不该动默认分支").not.toBe(res.sha);
    },
    120_000,
  );
});
