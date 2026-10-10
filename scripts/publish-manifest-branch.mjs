#!/usr/bin/env node
/**
 * publish-manifest-branch.mjs — 更新 manifest 的唯一发布出口。
 *
 * 2026-10-10 定性：客户端第 1 更新源读的是 Gitee 上的 `releases` 分支，而 Gitee 那条分支
 * 一直是手工建的孤儿分支。Gitee 的「仓库镜像管理」同步的是**整个分支集合**，并且会
 * 「删除在远程仓库中不存在的分支和标签」⇒ 上游 GitHub 没有 `releases` 时，**每推一次
 * GitHub 就剪一次 Gitee 的 releases**，第 1 源随之 404（实测时间链：09:03:53Z 推 GitHub →
 * 09:04:08Z 同步完成 → 分支没了 → 两份 raw manifest 同时 404，而 raw/master 与发行版附件照旧 200）。
 *
 * 所以这个文件把 push 目标从 Gitee 换成 **GitHub 的 `releases` 分支**：分支在上游存在，
 * 镜像就不会剪它，还会替我们把它搬到 Gitee（实测搬运 4s 发起 / 11s 完成；Gitee raw 边缘
 * 节点另需 20–100s 生效）。Gitee 从「被剪的那一份」变成承运人，本仓不再需要 Gitee 写令牌。
 *
 * 🔴 两条硬约束（都不是可从代码随手看出的取舍）：
 *  1. **只许 fast-forward，绝不 force / 绝不重写历史**。镜像同步对非 FF 的分支更新会拒绝，
 *     Gitee 那份就会停在旧 sha 上；而 `update.rs` 的语义是「manifest 读得到但版本不比当前新
 *     → 判『已是最新』，后面的源不再试」⇒ 一条旧 manifest 比 404 更毒。
 *  2. **只覆盖自己那一份文件，绝不清空 `latest/`**。目录里同时住着桌面与手机两份 manifest，
 *     谁 wipe 谁就在发版那一步删掉对端的第 1 更新源（2026-10-09 的真事故）。
 *
 * 用法：
 *   node scripts/publish-manifest-branch.mjs --file dist/updater-gitee.json
 *   node scripts/publish-manifest-branch.mjs --file a.json --file b.json --gitee-repo lzul/pastepanda
 *   环境变量：GH_TOKEN / GITHUB_TOKEN（CI 用 secrets.GITHUB_TOKEN；本地留空则取 `gh auth token`）
 *             GH_REPO（默认 lzlkyb/pastepanda）
 *   --dry-run  只演示要复制哪几个文件，不 clone 不 push
 *   --no-verify-readback  跳过「GitHub sha == Gitee sha == raw 读得到」的三段验证
 */

import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

export const MANIFEST_BRANCH = "releases";
export const MANIFEST_DIR = "latest";
export const DEFAULT_GH_REPO = "lzlkyb/pastepanda";
export const DEFAULT_GITEE_REPO = "lzul/pastepanda";

/** 镜像同步 + raw 边缘传播的实测窗口：11s / 20–100s，最坏见过 4 分钟。 */
export const DEFAULT_RETRY_WAITS = [30, 60, 90, 120, 150];

const info = (m) => console.log(`\x1b[36m[manifest-branch]\x1b[0m ${m}`);
const ok = (m) => console.log(`\x1b[32m[OK]\x1b[0m ${m}`);

/** clone/push 用的带令牌地址。令牌只进请求，不进任何一行日志。 */
export function githubGitUrl(repo, token) {
  if (!repo || !token) throw new Error("拼 GitHub 远端地址需要 repo 与 token 两者");
  return `https://x-access-token:${token}@github.com/${repo}.git`;
}

/** 把 URL / git 输出里的凭据打掉，失败信息才敢直接打印。 */
export function sanitizeRemote(text) {
  return String(text).replace(/(https?:\/\/)[^@\s/]+@/g, "$1***@");
}

/** 待复制的文件：只认 basename，落到 latest/ 下同名。 */
export function planFiles(files) {
  if (!Array.isArray(files) || files.length === 0) throw new Error("没有指定要发布的 manifest 文件");
  return files.map((f) => {
    const name = path.basename(String(f));
    if (!/^[A-Za-z0-9._-]+\.json$/.test(name)) throw new Error(`manifest 文件名不合形态：${name}`);
    return { src: path.isAbsolute(String(f)) ? String(f) : path.resolve(ROOT, String(f)), name };
  });
}

/**
 * 推送参数：**没有 -f / --force / --no-verify**。
 * 导出去给守卫当靶子——把 force 加回来时守卫要变红，而不是靠注释里那句「别 force」。
 */
export function pushArgs(branch = MANIFEST_BRANCH) {
  return ["push", "origin", branch];
}

/** 每份文件单独 `git add latest/<name>`，不用 `-A latest`（那会把别人的 manifest 一起提交，也会提交删除）。 */
export function addArgs(names) {
  return ["add", "--", ...names.map((n) => `${MANIFEST_DIR}/${n}`)];
}

/**
 * 三段验证的判定（纯函数）：推下去 ≠ 客户端读得到。
 * versions/expected 都是 { 文件名: version }；返回卡住的段名，全到位返回 "ok"。
 */
export function verifyVerdict({ pushedSha, ghSha, giteeSha, versions, expected }) {
  if (ghSha !== pushedSha) return "github";
  if (giteeSha !== pushedSha) return "mirror";
  for (const name of Object.keys(expected)) {
    if (versions[name] !== expected[name]) return "cdn";
  }
  return "ok";
}

/** 三段各自的修法提示：失败时别让人去猜是路径错了还是 Gitee 卡了。 */
export const VERIFY_STAGE_HINT = {
  github: "GitHub 的 releases 分支 sha 没跟上——push 其实没生效（查令牌写权限 / 分支保护 / 非 FF 被拒）",
  mirror: "Gitee 镜像还没把这条分支搬过去（同步由 GitHub push 触发，实测 4–11s；超过整个等待档就是没搬）",
  cdn: "Gitee 分支 sha 已一致，但 raw 边缘节点还在回旧内容（实测传播 20–100s）",
};

function runGit(args, label, { cwd, allowFail = false } = {}) {
  const r = spawnSync("git", args, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  const out = sanitizeRemote(`${r.stdout || ""}${r.stderr || ""}`);
  if (r.status !== 0 && !allowFail) {
    throw new Error(`${label} 失败（exit ${r.status}）：\n${out.slice(0, 2000)}`);
  }
  return { status: r.status, out, stdout: sanitizeRemote(r.stdout || "") };
}

/**
 * clone releases 分支；分支不存在时从默认分支建孤儿分支（只在 GitHub 侧，Gitee 侧不再手工建）。
 * unborn HEAD 上的 reset --hard 是必需的：不清索引的话孤儿分支会把 master 全部源码一起提交。
 */
function prepareWorktree(url, dir) {
  const first = runGit(["clone", "--depth", "1", "--branch", MANIFEST_BRANCH, url, dir], `clone ${MANIFEST_BRANCH}`, {
    allowFail: true,
  });
  if (first.status === 0) return false;
  if (!/Remote branch|not found in upstream|did not match any file/i.test(first.out)) {
    throw new Error(`clone ${MANIFEST_BRANCH} 失败，且不是「分支不存在」这一类（先查令牌写权限与仓库路径 ${sanitizeRemote(url)}）：\n${first.out.slice(0, 1500)}`);
  }
  info(`${MANIFEST_BRANCH} 分支不存在，从默认分支建孤儿分支重建`);
  rmSync(dir, { recursive: true, force: true });
  runGit(["clone", "--depth", "1", url, dir], "clone 默认分支");
  runGit(["-C", dir, "checkout", "--orphan", MANIFEST_BRANCH], "创建孤儿分支");
  runGit(["-C", dir, "reset", "--hard"], "清空孤儿分支索引");
  return true;
}

/**
 * 主流程：clone → 复制指定文件 → 提交 → FF push → 返回新 sha。
 * `nothing to commit` 不算失败：内容与分支上的一致时直接进验证段。
 */
export function publishManifestBranch({ repo, token, files, workDir, identity, remote, dryRun = false }) {
  const planned = planFiles(files);
  if (dryRun) {
    planned.forEach((p) => info(`DRY_RUN：会把 ${p.src} → ${MANIFEST_DIR}/${p.name}`));
    return { sha: null, files: planned, dryRun: true };
  }
  // remote 只给「用本地 bare 仓库端到端彩排」的测试用；生产调用方一律走 repo + token。
  const url = remote ?? githubGitUrl(repo, token);
  const dir = workDir ?? mkdtempSync(path.join(tmpdir(), "pp-manifest-branch-"));
  try {
    prepareWorktree(url, dir);
    mkdirSync(path.join(dir, MANIFEST_DIR), { recursive: true });
    for (const p of planned) {
      copyFileSync(p.src, path.join(dir, MANIFEST_DIR, p.name));
      info(`已放入 ${MANIFEST_DIR}/${p.name}（不清空目录，对端那份照原样留着）`);
    }
    runGit(addArgs(planned.map((p) => p.name)), "git add", { cwd: dir });
    const who = identity ?? { email: "ci@pastepanda.local", name: "pastepanda-ci" };
    const commit = runGit(
      ["-c", `user.email=${who.email}`, "-c", `user.name=${who.name}`, "commit", "-m", `release: update ${MANIFEST_DIR}/ manifest`],
      "git commit",
      { cwd: dir, allowFail: true },
    );
    const head = runGit(["rev-parse", "HEAD"], "git rev-parse", { cwd: dir }).stdout.trim();
    if (/nothing (to commit|anything staged)/i.test(commit.out)) {
      ok(`内容与 ${MANIFEST_BRANCH} 分支上的一致（nothing to commit），跳过 push：sha=${head}`);
      return { sha: head, files: planned, pushed: false };
    }
    if (commit.status !== 0) throw new Error(`git commit 失败：\n${commit.out.slice(0, 1500)}`);
    const push = runGit(pushArgs(), "git push", { cwd: dir, allowFail: true });
    if (push.status !== 0) {
      throw new Error(
        `push ${MANIFEST_BRANCH} 失败。这里**不用 force**：镜像同步拒绝非 FF 的分支更新，` +
          `force 会让 Gitee 停在旧 sha 上、客户端读到一条旧 manifest（比 404 更毒）。\n` +
          `先判读：\n${push.out.slice(0, 1500)}`,
      );
    }
    ok(`已 FF 推送 ${repo}@${MANIFEST_BRANCH}：sha=${head}`);
    return { sha: head, files: planned, pushed: true };
  } finally {
    // 临时 clone 的 .git/config 里带着令牌，用完即删
    if (!workDir) rmSync(dir, { recursive: true, force: true });
  }
}

/** 匿名读一条分支的 sha；读不到返回 null（分支不存在或连不上，两者都由调用方结合上下文判）。 */
export function remoteHeadSha(remoteUrl, branch = MANIFEST_BRANCH) {
  const r = runGit(["ls-remote", "--heads", remoteUrl, branch], "git ls-remote", { allowFail: true });
  if (r.status !== 0) return null;
  const line = r.stdout.split(/\r?\n/).find((l) => l.includes(`refs/heads/${branch}`));
  return line ? line.split(/\s+/)[0] : null;
}

export const giteeRawManifestUrl = (repo, name) =>
  `https://gitee.com/${repo}/raw/${MANIFEST_BRANCH}/${MANIFEST_DIR}/${name}`;

/** 读一份 raw manifest 的 version；读不到返回 null，不编造「它不存在」。 */
export async function readRawVersion(url) {
  try {
    const r = await fetch(url, { redirect: "follow" });
    if (!r.ok) return null;
    const j = await r.json().catch(() => null);
    return j?.version ?? null;
  } catch {
    return null;
  }
}

/**
 * 三段验证：GitHub sha → Gitee 分支 sha → Gitee raw 读得到且版本对。
 * expected 是 { 文件名: 该文件本应的 version }，逐份比对。
 * 每段失败都打印「卡在哪一段」，不再一句「读不到」把三种成因混成一团。
 */
export async function verifyChannel({ ghRepo, giteeRepo, pushedSha, expected, waits = DEFAULT_RETRY_WAITS }) {
  const names = Object.keys(expected);
  if (names.length === 0) throw new Error("verifyChannel 至少要有一份要读的 manifest");
  let last = null;
  for (let i = 0; i <= waits.length; i++) {
    const ghSha = remoteHeadSha(`https://github.com/${ghRepo}.git`);
    const giteeSha = remoteHeadSha(`https://gitee.com/${giteeRepo}.git`);
    const versions = {};
    for (const n of names) versions[n] = await readRawVersion(giteeRawManifestUrl(giteeRepo, n));
    const stage = verifyVerdict({ pushedSha, ghSha, giteeSha, versions, expected });
    last = { stage, ghSha, giteeSha, versions };
    if (stage === "ok") {
      ok(`通道三段全绿：GitHub=${ghSha}｜Gitee=${giteeSha}｜raw=${names.map((n) => `${n}:${versions[n]}`).join(" ")}`);
      return last;
    }
    if (i === waits.length) break;
    info(
      `验证第 ${i + 1} 轮卡在「${VERIFY_STAGE_HINT[stage]}」` +
        `（github=${ghSha ?? "读不到"} gitee=${giteeSha ?? "读不到"} raw=${JSON.stringify(versions)}），${waits[i]}s 后重试`,
    );
    await new Promise((r) => setTimeout(r, waits[i] * 1000));
  }
  throw new Error(
    `验证未通过，最后卡在「${VERIFY_STAGE_HINT[last.stage]}」\n  github=${last.ghSha ?? "读不到"}｜gitee=${last.giteeSha ?? "读不到"}｜raw=${JSON.stringify(last.versions)}｜期望 sha=${pushedSha} version=${JSON.stringify(expected)}`,
  );
}

function ghToken() {
  const fromEnv = (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "").trim();
  if (fromEnv) return fromEnv;
  const r = spawnSync("gh", ["auth", "token"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
}

function localManifestVersion(src) {
  const raw = readFileSync(src, "utf8");
  const j = JSON.parse(raw);
  if (!j.version) throw new Error(`${path.basename(src)} 里没有 version 字段，验证段没法比对`);
  return j.version;
}

/**
 * 命令行解析。空值一律回落到默认：CI 里 `$env:GITEE_REPOSITORY` 在 secret 未配时是**空串**，
 * 它会被作为一个参数传进来。若直接当仓库名用，三段验证会去拼 `https://gitee.com//raw/...`
 * ⇒ 404 ⇒ 把一次已经 FF 成功的发布判成红——正是本模块要治的「最后一步提前判红」。
 */
export function parseArgs(argv) {
  const files = [];
  for (let i = 0; i < argv.length; i++) if (argv[i] === "--file") files.push(argv[++i]);
  const at = argv.indexOf("--gitee-repo");
  const giteeRepo = (at >= 0 ? argv[at + 1] : "") || DEFAULT_GITEE_REPO;
  return {
    files,
    giteeRepo,
    verify: !argv.includes("--no-verify-readback"),
    dryRun: argv.includes("--dry-run"),
  };
}

export async function main(argv = process.argv.slice(2)) {
  const { files, giteeRepo, verify, dryRun } = parseArgs(argv);
  const planned = planFiles(files);
  const repo = process.env.GH_REPO || DEFAULT_GH_REPO;
  info(`目标：${repo}@${MANIFEST_BRANCH}/${MANIFEST_DIR}/｜文件=${planned.map((p) => p.name).join(", ")}`);
  const token = ghToken();
  if (!token && !dryRun) throw new Error("拿不到 GitHub 令牌（CI 传 secrets.GITHUB_TOKEN，本地用 gh auth token）");

  const res = publishManifestBranch({ repo, token, files: planned.map((p) => p.src), dryRun });
  if (res.dryRun) return res;

  if (!verify) {
    info("--no-verify-readback：跳过三段验证（由调用方自己回读时使用）");
    return res;
  }
  const expected = {};
  for (const p of planned) expected[p.name] = localManifestVersion(p.src);
  return verifyChannel({ ghRepo: repo, giteeRepo, pushedSha: res.sha, expected });
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main().catch((e) => {
    console.error(`\x1b[31m[FAIL]\x1b[0m ${e?.message ?? e}`);
    console.error(`::error title=manifest 分支发布::${String(e?.message ?? e).replace(/\n/g, " ")}`);
    process.exit(1);
  });
}
