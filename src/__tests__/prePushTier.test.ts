import { describe, expect, it } from "vitest";

import { decideTier } from "../../scripts/prePushTier.mjs";

/**
 * 钉住 pre-push 的判档器。它决定「这次 push 要不要付全量测试」，判错的后果是两种相反的病：
 * 该 full 却走 light ⇒ master 可能被推红；该 light 却走 full ⇒ 退回「同一套测试本地 CI 各付一遍」。
 * 所以这里每一档都配一条反例，不是走过场。
 */

const refLine = (localRef: string, remoteRef: string) =>
  `${localRef} 1111111111111111111111111111111111111111 ${remoteRef} 2222222222222222222222222222222222222222`;

describe("pre-push 判档器", () => {
  it("推 master 走全量", () => {
    expect(decideTier(refLine("refs/heads/master", "refs/heads/master"))).toBe("full");
  });

  it("从别的本地分支名直接推到 master 也走全量（判据是远端 ref，不是本地分支名）", () => {
    expect(decideTier(refLine("refs/heads/fix/my-thing", "refs/heads/master"))).toBe("full");
  });

  it("推 tag 走全量（tag 会触发 release.yml，是对外动作）", () => {
    expect(decideTier(refLine("refs/tags/v7.2.12", "refs/tags/v7.2.12"))).toBe("full");
  });

  it("分支和 tag 一次推：只要掺了 tag 就是全量", () => {
    const stdin = [refLine("refs/heads/chore/x", "refs/heads/chore/x"), refLine("refs/tags/v7.2.12", "refs/tags/v7.2.12")].join("\n");
    expect(decideTier(stdin)).toBe("full");
  });

  it("推特性分支走轻档", () => {
    for (const b of ["fix/a", "feature/a", "chore/a", "agent/sess/a", "docs/a"]) {
      expect(decideTier(refLine(`refs/heads/${b}`, `refs/heads/${b}`)), b).toBe("light");
    }
  });

  it("删远端分支走轻档（它不动 master 尖端，也不发版）", () => {
    const deleteLine = "(delete) 0000000000000000000000000000000000000000 refs/heads/feature/done 2222222222222222222222222222222222222222";
    expect(decideTier(deleteLine)).toBe("light");
  });

  it("读不到任何 ref 时走全量（GUI 客户端不喂 stdin 的兜底方向必须是重的）", () => {
    for (const empty of ["", "\n", "   \n"]) {
      expect(decideTier(empty), JSON.stringify(empty)).toBe("full");
    }
  });

  it("远端 ref 字段缺失时不会误判成轻档", () => {
    expect(decideTier("refs/heads/master 1111")).toBe("full");
  });
});
