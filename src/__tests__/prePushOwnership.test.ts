import { describe, expect, it } from "vitest";

import { decideOwnership } from "../../scripts/prePushTier.mjs";

/**
 * 钉住「这次 push 会不会抹掉别人的提交」。
 *
 * 背景：分支保护只覆盖 master，`feature/<别人的账号>` 这类协助者自己的分支，
 * 管理员 force push 覆盖时 GitHub 不会拦也不会提示。钩子是本机唯一能拦的地方。
 *
 * 这里注入假 repo（`decideOwnership` 的判据全是本地 git 对象能回答的问题），
 * 所以每条都是真断言，不是数字符串。CLI 那半边（真的 execFileSync git）由
 * `.cache/` 里现造的临时仓库跑一次端到端验证，配方记在 CONTRIBUTING §3.10。
 */

const ME = "43698433+lzlkyb@users.noreply.github.com";
const HIM = "kynnzhou@example.com";
// AGENTS 21：本机改身份前的地址，仓里 616 笔提交挂着它。
const LEGACY = "dev@clipboard-manager.local";

const line = (localRef: string, localSha: string, remoteRef: string, remoteSha: string) =>
  `${localRef} ${localSha} ${remoteRef} ${remoteSha}`;

interface FixtureNode {
  author: string;
  parents: string[];
}

/**
 * fixture: { [sha]: { author, parents } }
 * isAncestor 用最朴素的可达性——测试用的图都是几节点的链，够了。
 */
function fakeRepo(fixture: Record<string, FixtureNode>) {
  const reachable = (from: string, via: string): boolean => {
    const node = fixture[from];
    if (!node) return false;
    return node.parents.some((p: string) => p === via || reachable(p, via));
  };
  return {
    exists: (sha: string) => Boolean(fixture[sha]),
    isAncestor: (a: string, b: string) => reachable(b, a),
    tipAuthor: (sha: string) => fixture[sha]?.author ?? null,
    droppedAuthors: (newSha: string, oldSha: string) => {
      const keep = new Set<string>();
      const collect = (sha: string) => {
        if (keep.has(sha) || !fixture[sha]) return;
        keep.add(sha);
        fixture[sha].parents.forEach(collect);
      };
      collect(newSha);
      const out: string[] = [];
      const walk = (sha: string) => {
        if (!fixture[sha] || keep.has(sha)) return;
        out.push(fixture[sha].author);
        fixture[sha].parents.forEach(walk);
      };
      walk(oldSha);
      return out;
    },
  };
}

describe("pre-push 覆盖守卫", () => {
  it("fast-forward 不拦（纯新增，什么都不销毁）", () => {
    const repo = fakeRepo({
      A: { author: HIM, parents: [] },
      B: { author: ME, parents: ["A"] },
      C: { author: ME, parents: ["B"] },
    });
    const { violations } = decideOwnership({
      refLines: line("refs/heads/fix/x", "C", "refs/heads/fix/x", "B"),
      myEmails: [ME],
      repo,
    });
    expect(violations).toEqual([]);
  });

  it("新分支（远端还没有这个 ref）不拦", () => {
    const repo = fakeRepo({ A: { author: ME, parents: [] } });
    const zeros = "0000000000000000000000000000000000000000";
    const { violations } = decideOwnership({
      refLines: line("refs/heads/feature/new", "A", "refs/heads/feature/new", zeros),
      myEmails: [ME],
      repo,
    });
    expect(violations).toEqual([]);
  });

  it("改写只涉及我自己的提交 → 放行（这就是今天的 --force-with-lease 场景）", () => {
    const repo = fakeRepo({
      A: { author: ME, parents: [] },
      B: { author: ME, parents: ["A"] },
      B2: { author: ME, parents: ["A"] },
    });
    const { violations } = decideOwnership({
      refLines: line("refs/heads/chore/x", "B2", "refs/heads/chore/x", "B"),
      myEmails: [ME],
      repo,
    });
    expect(violations).toEqual([]);
  });

  it("强推覆盖掉协助者的提交 → 判违规，并带上被丢弃的作者", () => {
    const repo = fakeRepo({
      A: { author: HIM, parents: [] },
      H: { author: HIM, parents: ["A"] },
      M: { author: ME, parents: ["A"] },
    });
    const { violations } = decideOwnership({
      refLines: line("refs/heads/mine", "M", "refs/heads/feature/kynnzhou-dev", "H"),
      myEmails: [ME],
      repo,
    });
    expect(violations.length).toBe(1);
    expect(violations[0].remoteRef).toBe("refs/heads/feature/kynnzhou-dev");
    expect(violations[0].dropped).toContain(HIM);
  });

  it("删除协助者的分支 → 判违规", () => {
    const repo = fakeRepo({ H: { author: HIM, parents: [] } });
    const zeros = "0000000000000000000000000000000000000000";
    const { violations } = decideOwnership({
      refLines: line(zeros, zeros, "refs/heads/feature/kynnzhou-dev", "H"),
      myEmails: [ME],
      repo,
    });
    expect(violations.length).toBe(1);
    expect(violations[0].dropped).toEqual([HIM]);
  });

  it("删除我自己的分支 → 放行", () => {
    const repo = fakeRepo({ M: { author: ME, parents: [] } });
    const zeros = "0000000000000000000000000000000000000000";
    const { violations } = decideOwnership({
      refLines: line(zeros, zeros, "refs/heads/chore/mine", "M"),
      myEmails: [ME],
      repo,
    });
    expect(violations).toEqual([]);
  });

  it("删除我自己的分支：历史里有 master 上别人的提交 → 仍放行（只看 tip 作者）", () => {
    // 分支历史必然从 master 继承一堆别人写的提交，按「全集里有没有外人」判
    // 等于永远删不掉自己的分支——所以删除档只看 tip。
    const repo = fakeRepo({
      A: { author: HIM, parents: [] },
      M: { author: ME, parents: ["A"] },
    });
    const zeros = "0000000000000000000000000000000000000000";
    const { violations } = decideOwnership({
      refLines: line(zeros, zeros, "refs/heads/chore/mine", "M"),
      myEmails: [ME],
      repo,
    });
    expect(violations).toEqual([]);
  });

  it("远端旧 tip 的对象本地没有 → 判不了就不拦（git 的 --force-with-lease 是第二道闸）", () => {
    const repo = fakeRepo({ A: { author: ME, parents: [] } });
    const { violations } = decideOwnership({
      refLines: line("refs/heads/x", "A", "refs/heads/feature/kynnzhou-dev", "GHOST"),
      myEmails: [ME],
      repo,
    });
    expect(violations).toEqual([]);
  });

  it("一次推多个 ref：违规的那条被抓出来，其它不背锅", () => {
    const repo = fakeRepo({
      A: { author: HIM, parents: [] },
      H: { author: HIM, parents: ["A"] },
      M: { author: ME, parents: ["A"] },
      N: { author: ME, parents: ["M"] },
    });
    const stdin = [
      line("refs/heads/mine", "N", "refs/heads/chore/mine", "M"),
      line("refs/heads/mine", "M", "refs/heads/feature/kynnzhou-dev", "H"),
    ].join("\n");
    const { violations } = decideOwnership({ refLines: stdin, myEmails: [ME], repo });
    expect(violations.length).toBe(1);
    expect(violations[0].remoteRef).toBe("refs/heads/feature/kynnzhou-dev");
  });

  it("ref 行字段数不对 → 不猜、不拦（分档那侧会因此走 full）", () => {
    const repo = fakeRepo({ A: { author: HIM, parents: [] } });
    const { violations } = decideOwnership({ refLines: "refs/heads/x", myEmails: [ME], repo });
    expect(violations).toEqual([]);
  });

  // 这台机器改身份前有 616 个提交是 dev@clipboard-manager.local（AGENTS 21）。
  // 同一条用例里对照两种身份表，保证「放行」不是因为断言写空了。
  it("本机历史身份（改地址前的 616 笔）算我的，不算覆盖别人", () => {
    const repo = fakeRepo({
      A: { author: LEGACY, parents: [] },
      B: { author: LEGACY, parents: ["A"] },
      B2: { author: ME, parents: ["A"] },
    });
    const refLines = line("refs/heads/chore/x", "B2", "refs/heads/chore/x", "B");
    expect(decideOwnership({ refLines, myEmails: [ME, LEGACY], repo }).violations).toEqual([]);
    expect(decideOwnership({ refLines, myEmails: [ME], repo }).violations.length).toBe(1);
  });
});
