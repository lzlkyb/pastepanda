import { describe, expect, it } from "vitest";
import {
  DEFAULT_RETRY_WAITS,
  MANIFEST_BRANCH,
  MANIFEST_DIR,
  addArgs,
  githubGitUrl,
  planFiles,
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
