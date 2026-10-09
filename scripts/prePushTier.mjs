#!/usr/bin/env node
// pre-push 的判档器 + 覆盖守卫：读 git 传给钩子的 ref 行，
// 决定这次 push 要不要付全量测试，以及要不要直接拒绝它。
//
// 为什么单独成文件（而不是写在钩子里的一段 case）：`.husky/pre-push` 与
// `.githooks/pre-push` 是两份必须逐字节等价的副本（见 prePushHookParity.test.ts），
// 判据写进 shell 就只能靠字符串断言；收口成纯函数后它能直接被 vitest 喂反例。
//
// stdin 格式（git 定义，每行四个字段）：
//   <local-ref> <local-sha> <remote-ref> <remote-sha>
// 某些 GUI 客户端调用钩子时不给 stdin ⇒ 读不到任何 ref，那种情况必须往重的方向掉。

import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** 只有这两种目标会改变「别人拉到的东西」：master 尖端、以及任何 tag（tag 触发 release.yml）。 */
const HEAVY_REF = /^refs\/(heads\/master|tags\/)/;

export function decideTier(stdinText) {
  const lines = stdinText.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return "full";
  // 第 3 个字段才是被推到的远端 ref；本地分支名可能随便起，不作判据。
  return lines.some((l) => {
    const fields = l.split(/\s+/);
    // 行形如「(delete) <sha> <ref> <old>」，字段数不对说明我们读不懂它——读不懂就往重的方向掉。
    if (fields.length < 4) return true;
    return HEAVY_REF.test(fields[2]);
  })
    ? "full"
    : "light";
}

const ZERO = /^0{40}$/;

/**
 * 覆盖检测：这次 push 会不会把「不是我的提交」从远端分支上抹掉。
 *
 * 为什么需要：master 的保护规则管不到别的分支——`feature/kynnzhou-dev` 这类
 * 协助者自己的分支，管理员照样能 force push 覆盖（2026-10-09 我给自己分支改写
 * 提交作者时就用过 `--force-with-lease`）。GitHub 那边不会有任何提示。
 *
 * 判据只用**本地已有的 git 对象**，不联网：
 *   - 远端旧 tip 不存在（新分支）→ 不覆盖任何东西
 *   - 旧 tip 是新 tip 的祖先（fast-forward）→ 纯新增
 *   - 否则被丢弃的提交（new..old）里只要有一个作者不是本机身份 → 判违规
 *   - 旧 tip 的对象本地没有 → 判不了，**不拦**（拦了就是把「没 fetch 过」当成罪证，
 *     而且 git 自己的 `--force-with-lease` 仍是第二道闸）
 *
 * 「本机身份」是一个集合而不是一个地址：见下面 LEGACY_OWN_EMAILS。
 *
 * @param {{refLines: string, myEmails: string[], repo: object}} input
 * @returns {{violations: Array<{remoteRef: string, dropped: string[], oldSha: string}>}}
 */
export function decideOwnership({ refLines, myEmails, repo }) {
  const mine = new Set(myEmails.filter(Boolean).map((e) => e.toLowerCase()));
  const violations = [];
  for (const line of refLines.split("\n").filter((l) => l.trim() !== "")) {
    const [localRef, newSha, remoteRef, oldSha] = line.split(/\s+/);
    void localRef;
    // 读不懂的行不拦：分档那侧已经因为字段数不对把整轮判成 full 了。
    if (!newSha || !remoteRef || !oldSha) continue;
    if (ZERO.test(oldSha)) continue; // 远端还没有这个 ref，销毁不了东西
    if (!repo.exists(oldSha)) continue; // 本地没这个对象 = 判不了，不拿「没 fetch」当罪证
    if (!ZERO.test(newSha) && repo.exists(newSha) && repo.isAncestor(oldSha, newSha)) continue; // fast-forward
    // 删除整个分支时只看 tip 作者：分支历史必然从 master 继承别人写的提交，
    // 按全集判等于永远删不掉自己的分支。tip = 「这条分支最后是谁在推」，够拦下删错人。
    const dropped = ZERO.test(newSha) ? [repo.tipAuthor(oldSha)] : repo.droppedAuthors(newSha, oldSha);
    const foreign = dropped.filter((email) => email && !mine.has(email.toLowerCase()));
    if (foreign.length > 0) violations.push({ remoteRef, dropped: foreign, oldSha });
  }
  return { violations };
}

/** sha 只可能是十六进制；不校验就让 stdin 的内容成了 git 的参数位。 */
const SAFE_SHA = /^[0-9a-fA-F]{4,40}$/;

function git(args) {
  try {
    return execFileSync("git", args, { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] });
  } catch {
    return null;
  }
}

/** decideOwnership 的真身：只用本地对象库，一次网络请求都不发。 */
const localRepo = {
  exists: (sha) => SAFE_SHA.test(sha) && git(["cat-file", "-e", `${sha}^{commit}`]) !== null,
  isAncestor: (a, b) => SAFE_SHA.test(a) && SAFE_SHA.test(b) && git(["merge-base", "--is-ancestor", a, b]) !== null,
  tipAuthor: (sha) => (SAFE_SHA.test(sha) ? git(["log", "-1", "--format=%ae", sha]) : "")?.trim() || null,
  droppedAuthors: (newSha, oldSha) => {
    if (!SAFE_SHA.test(newSha) || !SAFE_SHA.test(oldSha)) return [];
    return (git(["log", "--format=%ae", `${newSha}..${oldSha}`]) ?? "")
      .split("\n")
      .map((s) => s.trim())
      .filter(Boolean);
  },
};

/**
 * 这台机器改身份之前写过 616 个提交（AGENTS 21），它们在所有分支历史里都是这个地址。
 * 不认它 = 「rebase 自己 2026-10-09 以前的分支」一律误判违规，而误判的出路是 --no-verify，
 * 那等于把整条守卫废掉。只列这一台机器的历史地址，别人的一个都不在里面。
 */
const LEGACY_OWN_EMAILS = ["dev@clipboard-manager.local"];

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  const stdinText = Buffer.concat(chunks).toString("utf8");
  // stdout 只输出档位——钩子用 `$(...)` 收；诊断信息一律走 stderr。
  process.stdout.write(decideTier(stdinText));

  // 退出码约定（钩子里有对应 case，改这里必须改两份 pre-push）：
  //   0 = 放行　9 = 这次 push 会抹掉别人的提交，拒绝　其它非 0 = 守卫自己没跑成，钩子降级成全量
  const myEmail = git(["config", "user.email"])?.trim() ?? "";
  if (myEmail === "") {
    process.stderr.write("  ⚠ 覆盖守卫跳过：本机没配 git user.email，无从判断「谁的不是我的」。\n");
  } else {
    const myEmails = [myEmail, ...LEGACY_OWN_EMAILS];
    const { violations } = decideOwnership({ refLines: stdinText, myEmails, repo: localRepo });
    if (violations.length > 0) {
      process.stderr.write(
        [
          "",
          "  ❌ 覆盖守卫：这次 push 会把不是本机身份写的提交从远端抹掉。",
          ...violations.map(
            (v) => `     · ${v.remoteRef}（远端现 tip ${v.oldSha.slice(0, 8)}）将丢弃作者 ${v.dropped.join(", ")} 的提交`
          ),
          `     本机认的身份：${myEmails.join(" / ")}`,
          "",
          "     这不是「一定有害」，但 master 的保护规则管不到别的分支，GitHub 不会提示你。",
          "     确认要覆盖：git push --no-verify（会同时跳过测试），或先把对方的提交 rebase 进来。",
          ""
        ].join("\n")
      );
      process.exitCode = 9;
    }
  }
}
