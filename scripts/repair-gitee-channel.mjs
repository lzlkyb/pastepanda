#!/usr/bin/env node
/**
 * repair-gitee-channel.mjs — Gitee 更新通道的自检 + 自愈。
 *
 * 问题：客户端第 1 条更新源指向 `https://gitee.com/<repo>/raw/releases/latest/updater-gitee.json`，
 * 它落在 Gitee 上一条只放 manifest 的 orphan 分支 `releases`。发版 CI 每次重建它，但事后会消失
 * （v7.2.9 与 v7.2.10 的日志里都是 `[new branch]` —— 连续两次都从零建，说明上一版留下的已被删）。
 * 本脚本不追究「谁删的」，只做一件事：**发现读不到（或读到的是过期版本）就补回去**。
 *
 * 为什么能纯派生、不需要重新构建：
 *   Gitee 源和 GitHub 直连源用的是**同一个 exe、同一份 minisign 签名**，只有取文件那条 URL 的
 *   主机不同（见 release.yml 里 UPDATER_URL_TEMPLATE 那段注释）。所以从 GitHub Release 上已经
 *   发布的 updater.json / apk-update.json 换 host，就是发版时生成的那份的等价物。
 *
 * 环境变量：
 *   GITEE_TOKEN       Gitee 写权限令牌（推送必需；DRY_RUN=1 时可省）
 *   GITEE_REPOSITORY  默认 lzul/pastepanda —— 必须与客户端硬编码的仓库一致，脚本会打印它
 *   GH_REPO           默认 lzlkyb/pastepanda
 *   GH_TOKEN          可选，提升 api.github.com 配额
 *   GH_TAG            可选，指定要恢复的 tag；留空 = GitHub 最新 Release
 *   DRY_RUN           =1 时只诊断 + 生成本地产物，不推送
 *
 * 🔴 为什么「版本对不上」必须硬失败，而不是「能读到就算好」：
 *   update.rs:367-370 的语义是 —— manifest 读得到但版本不比当前新，就 `return Ok(None)`
 *   判「已是最新版本」，**后面的源不再试**。所以把一条过期 manifest 补回 Gitee 比 404 更糟：
 *   404 至少会降级到 ghproxy/GitHub，过期 manifest 会让用户彻底收不到更新。
 *   同理，指向 404 附件的 manifest 也不许发出去（第 3 步的 Range 前置检查）。
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const GH_REPO = process.env.GH_REPO || "lzlkyb/pastepanda";
// 客户端 tauri.conf.json 里硬编码的就是这条仓库路径；改这里不改那里会静默镜像到没人读的仓库，
// 所以它导出去给 scripts/repair-gitee-channel.test.ts 当交叉守卫。
export const DEFAULT_GITEE_REPO = "lzul/pastepanda";
const GITEE_REPO = process.env.GITEE_REPOSITORY || DEFAULT_GITEE_REPO;
const GITEE_TOKEN = (process.env.GITEE_TOKEN || "").trim();
const GH_TOKEN = (process.env.GH_TOKEN || "").trim();
const DRY_RUN = process.env.DRY_RUN === "1" || process.env.DRY_RUN === "true";
const GH_RELEASE_PREFIX = `https://github.com/${GH_REPO}/releases/download/`;

/** 客户端读的那个地址（manifest 走 raw，小文件免登录；大文件走 releases/download 附件）。 */
export const giteeRawManifestUrl = (repo, name) => `https://gitee.com/${repo}/raw/releases/latest/${name}`;

// 客户端两个端点列表的第 1 条各读一份，两份都得活着
export const TARGETS = [
  { name: "updater-gitee.json", ghSource: "updater.json", kind: "desktop", list: "endpoints" },
  { name: "apk-update-gitee.json", ghSource: "apk-update.json", kind: "apk", list: "apkEndpoints" },
];

const info = (m) => console.log(`\x1b[36m[repair-gitee]\x1b[0m ${m}`);
const ok = (m) => console.log(`\x1b[32m[OK]\x1b[0m ${m}`);
const warn = (m) => console.log(`\x1b[33m[WARN]\x1b[0m ${m}`);
// annotation 进 run 的 Annotations 区，不看完整日志也能拿到结论
const note = (m) => console.log(`::notice title=Gitee 通道::${m}`);
function fail(m) {
  console.error(`\x1b[31m[FAIL]\x1b[0m ${m}`);
  console.error(`::error title=Gitee 通道自愈失败::${m.replace(/\n/g, " ")}`);
  process.exit(1);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** GitHub 发行版直链 → Gitee 发行版附件直链（同 tag 同文件名，只换主机）。 */
export function toGiteeUrl(url, giteeRepo) {
  if (typeof url !== "string" || !url.startsWith(GH_RELEASE_PREFIX)) {
    throw new Error(
      `URL 不是本仓 GitHub 发行版直链，不猜它的 Gitee 对应物：${url}\n` +
        `  期望前缀：${GH_RELEASE_PREFIX}`,
    );
  }
  const rest = url.slice(GH_RELEASE_PREFIX.length);
  if (!rest || rest.includes("?") || rest.includes("#")) {
    throw new Error(`GitHub 发行版直链形态异常：${url}`);
  }
  return `https://gitee.com/${giteeRepo}/releases/download/${rest}`;
}

/** 派生桌面 manifest：验签要跟着走，所以 signature 必须非空。 */
export function deriveDesktop(manifest, giteeRepo) {
  const platforms = manifest?.platforms;
  if (!platforms || typeof platforms !== "object" || Object.keys(platforms).length === 0) {
    throw new Error("updater.json 里没有 platforms，或它是空的");
  }
  const out = {};
  for (const [key, p] of Object.entries(platforms)) {
    if (!p?.signature) throw new Error(`platforms.${key} 缺 signature —— 补出去客户端必然验签失败`);
    if (!p?.url) throw new Error(`platforms.${key} 缺 url`);
    out[key] = { signature: p.signature, url: toGiteeUrl(p.url, giteeRepo) };
  }
  return { ...manifest, platforms: out };
}

/** 派生 APK manifest：客户端按 sha256 校验完整性（update_android.rs），缺它就是坏 manifest。 */
export function deriveApk(manifest, giteeRepo) {
  if (!/^[0-9a-f]{64}$/.test(manifest?.sha256 ?? "")) {
    throw new Error("apk-update.json 缺 sha256（或非 64 位小写十六进制）");
  }
  if (!manifest.url) throw new Error("apk-update.json 缺 url");
  return { ...manifest, url: toGiteeUrl(manifest.url, giteeRepo) };
}

export function deriveManifest(kind, manifest, giteeRepo) {
  return kind === "apk" ? deriveApk(manifest, giteeRepo) : deriveDesktop(manifest, giteeRepo);
}

async function getJson(url, tries = 3) {
  let last = "未执行";
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, {
        redirect: "follow",
        headers: GH_TOKEN && url.startsWith("https://api.github.com/") ? { Authorization: `Bearer ${GH_TOKEN}` } : {},
      });
      if (!r.ok) {
        last = `HTTP ${r.status}`;
      } else {
        const body = await r.json().catch(() => null);
        if (body === null) throw new Error(`响应不是 JSON（大概率是被重定向到的网页）：${url}`);
        return { body, status: r.status };
      }
    } catch (e) {
      last = String(e?.message || e);
    }
    if (i < tries) await sleep(i * 3000);
  }
  return { body: null, status: 0, error: last };
}

/** 附件必须匿名可下：发出去一条指向 404 的 manifest 只是把「查不到更新」换成「下载失败」。 */
async function assertDownloadable(url) {
  try {
    const r = await fetch(url, { method: "GET", headers: { Range: "bytes=0-1023" }, redirect: "follow" });
    return r.status;
  } catch {
    return 0;
  }
}

function git(args, label) {
  const r = spawnSync("git", args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) {
    const out = `${r.stderr || ""}${r.stdout || ""}`.replace(/oauth2:[^@]+@/g, "oauth2:***@");
    fail(`${label} 失败：\n${out.slice(0, 2000)}`);
  }
  return r.stdout || "";
}

async function main() {
  info(`GitHub 仓库：${GH_REPO}｜Gitee 仓库：${GITEE_REPO}（客户端硬编码的是后者，不一致就是镜像到了没人读的仓库）`);

  // 1) 目标 tag
  let tag = (process.env.GH_TAG || "").trim();
  let expectedVersion;
  if (tag) {
    expectedVersion = tag.replace(/^v/, "");
  } else {
    const latest = await getJson(`https://api.github.com/repos/${GH_REPO}/releases/latest`);
    if (!latest.body?.tag_name) fail(`拿不到最新 Release（${latest.error || latest.status}）；可用 GH_TAG 指定 tag`);
    tag = latest.body.tag_name;
    expectedVersion = tag.replace(/^v/, "");
  }
  info(`目标版本：tag=${tag} version=${expectedVersion}`);

  // 2) 现状探针：Gitee 上两份 manifest 读得到吗、版本是不是目标版本
  const state = {};
  for (const t of TARGETS) {
    const probe = await getJson(giteeRawManifestUrl(GITEE_REPO, t.name), 1);
    const got = probe.body?.version ?? null;
    state[t.name] = { healthy: got === expectedVersion, got, raw: probe };
    info(`探针 ${t.name}: ${probe.body ? `HTTP ${probe.status} version=${got}` : `读不到（${probe.error || probe.status}）`} → ${state[t.name].healthy ? "健康" : "需修复"}`);
  }
  if (TARGETS.every((t) => state[t.name].healthy)) {
    ok("Gitee 通道两份 manifest 都在且版本正确，本次无需动作。");
    return;
  }

  // 判断到底是「整条分支没了」还是「分支在、文件旧」——这两种的后续处理不同，
  // 而且前者是这条通道反复失效的根因证据，定时跑几次就能定性，不用再靠猜。
  const heads = spawnSync("git", ["ls-remote", "--heads", `https://gitee.com/${GITEE_REPO}.git`], { encoding: "utf8" });
  const anonLs = (heads.stdout || "").trim().split(/\r?\n/).map((l) => l.split("\t")[1]).filter(Boolean);
  const branchExists = anonLs.includes("refs/heads/releases");
  note(
    `需修复=${TARGETS.filter((t) => !state[t.name].healthy).map((t) => `${t.name}(读到 ${state[t.name].got ?? "404"})`).join(", ")}` +
      `｜releases 分支存在=${branchExists}｜匿名可见分支=${anonLs.join(",") || "(空)"}`,
  );

  // 3) 从 GitHub 已发布的 manifest 派生
  const built = [];
  const skipped = [];
  for (const t of TARGETS) {
    if (state[t.name].healthy) {
      info(`跳过 ${t.name}（它本身是健康的，不要拿新内容去覆盖一条正在工作的 manifest）`);
      continue;
    }
    const src = await getJson(`${GH_RELEASE_PREFIX}${tag}/${t.ghSource}`);
    if (!src.body) {
      // 404 与「取不到」必须分开：把网络抖动当成「这个 Release 没有 APK 资产」，
      // 就会每天安静地少修一份，而日志读起来像是有意为之。
      if (t.kind === "apk" && src.status === 404) {
        warn(`${t.ghSource} 在该 Release 不存在（HTTP 404），只修桌面侧`);
        skipped.push(`${t.name}：GitHub 侧没有 ${t.ghSource}`);
        continue;
      }
      fail(`读不到 ${t.ghSource}（${src.error || src.status}）：${GH_RELEASE_PREFIX}${tag}/${t.ghSource}`);
    }
    if (src.body.version !== expectedVersion) {
      fail(`${t.ghSource} 的 version=${src.body.version} 与 tag ${tag} 不一致，拒绝据此生成 Gitee manifest`);
    }
    let derived;
    try {
      derived = deriveManifest(t.kind, src.body, GITEE_REPO);
    } catch (e) {
      fail(`${t.name} 派生失败：${e.message}`);
    }
    // 桌面与手机的通道各自独立：APK 没挂上 Gitee 发行版时，只放过桌面那一份，
    // 不因为一份修不了就把另一份也扣住（那正是用户此刻等的那个 10 KB/s 的装机包）。
    const urls = t.kind === "apk" ? [derived.url] : Object.values(derived.platforms).map((p) => p.url);
    const missing = [];
    for (const url of urls) {
      const st = await assertDownloadable(url);
      if (st === 404 || st === 403) {
        // 明确的「不存在 / 要登录」才叫缺附件
        missing.push(`HTTP ${st}`);
        warn(`Gitee 附件不可下（HTTP ${st}）：${url}`);
      } else if (st !== 200 && st !== 206) {
        fail(
          `探测 Gitee 附件时网络异常（HTTP ${st}）：${url}\n` +
            `  这不能当成「附件不存在」——那样会把一次抖动记成一份永久跳过。本次失败，等下一轮自愈。`,
        );
      } else {
        ok(`附件可下（HTTP ${st}）：${url}`);
      }
    }
    if (missing.length) {
      skipped.push(
        `${t.name}：manifest 指向的包不在 Gitee 发行版附件里（${missing.join(", ")}）。` +
          `补救 = 重跑发版 CI 的「镜像发布产物到 Gitee」/ android.yml 的三源发布，或本地 tools/upload-exe-to-gitee.ps1 -Version ${expectedVersion}`,
      );
      continue;
    }
    built.push({ ...t, body: derived });
  }
  if (skipped.length) {
    console.log(
      `::warning title=Gitee 通道未完全修复::${skipped.join(" ｜ ").replace(/\n/g, " ")}`,
    );
  }
  if (built.length === 0) {
    fail(
      `两份 manifest 都修不了，通道仍是坏的：\n  ${skipped.join("\n  ") || "（探针说它健康，逻辑矛盾，请核对上面输出）"}`,
    );
  }

  const outDir = path.join(ROOT, "dist", "gitee-repair");
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const b of built) {
    writeFileSync(path.join(outDir, b.name), JSON.stringify(b.body, null, 2) + "\n", "utf8");
    info(`已生成 ${b.name}（version=${b.body.version}）`);
  }

  if (DRY_RUN) {
    info("DRY_RUN=1：诊断与产物已就绪，不推送。");
    return;
  }
  if (!GITEE_TOKEN) fail("缺少 GITEE_TOKEN（推送需要它；只想看诊断用 DRY_RUN=1）");

  // 4) 推上 releases 分支 latest/
  //    镜像工作目录放在 dist/ 里（.gitignore 已忽略）：万一进程被中断留下目录，
  //    也不会在共享工作树里长出一个没人认领的未跟踪文件夹。
  const mirror = mkdtempSync(path.join(ROOT, "dist", "gitee-repair-mirror-"));
  const giteeGit = `https://oauth2:${GITEE_TOKEN}@gitee.com/${GITEE_REPO}.git`;
  try {
    const clone = spawnSync("git", ["clone", "--depth", "1", "--branch", "releases", giteeGit, mirror], { encoding: "utf8" });
    if (clone.status !== 0) {
      info("releases 分支不存在，clone 默认分支后建孤儿分支（与 release.yml 同一套做法）");
      rmSync(mirror, { recursive: true, force: true });
      git(["clone", "--depth", "1", giteeGit, mirror], "clone Gitee 默认分支");
      git(["-C", mirror, "checkout", "--orphan", "releases"], "创建 releases 孤儿分支");
      // unborn HEAD 上的 reset --hard 会清空索引：不清的话，孤儿分支会把 master 的全部
      // 源码一起提交进去（发版 CI 里那句 reset 就是干这个的）。
      git(["-C", mirror, "reset", "--hard"], "清空孤儿分支索引");
    }
    const latest = path.join(mirror, "latest");
    mkdirSync(latest, { recursive: true });
    for (const b of built) writeFileSync(path.join(latest, b.name), readFileSync(path.join(outDir, b.name), "utf8"), "utf8");

    git(["-C", mirror, "add", "-A", "latest"], "git add latest");
    const commit = spawnSync("git", ["-C", mirror, "-c", "user.email=ci@pastepanda.local", "-c", "user.name=pastepanda-ci", "commit", "-m", `release: repair Gitee channel manifests for ${tag}`], { encoding: "utf8" });
    const commitOut = `${commit.stdout || ""}${commit.stderr || ""}`;
    if (commit.status !== 0 && !/nothing to commit/.test(commitOut)) {
      fail(`git commit 失败：\n${commitOut.slice(0, 1500)}`);
    }
    if (/nothing to commit/.test(commitOut) && branchExists) {
      info("内容与分支上的一致（nothing to commit），跳过 push，直接进回读验证");
    } else {
      let push = spawnSync("git", ["-C", mirror, "push", "origin", "releases"], { encoding: "utf8" });
      if (push.status !== 0) {
        info("第一次 push 失败，按既有经验用 postBuffer + --no-thin 重试");
        push = spawnSync("git", ["-C", mirror, "-c", "http.postBuffer=524288000", "push", "--no-thin", "origin", "releases"], { encoding: "utf8" });
        if (push.status !== 0) {
          fail(`git push 两次都失败：\n${`${push.stderr}${push.stdout}`.replace(/oauth2:[^@]+@/g, "oauth2:***@").slice(0, 2000)}`);
        }
      }
      ok(`已推送 releases/latest/（${built.map((b) => b.name).join(", ")}）`);
    }
  } finally {
    // 临时 clone 的 .git/config 里带着 token，用完即删
    rmSync(mirror, { recursive: true, force: true });
  }

  // 5) 回读验证：推上去 ≠ 客户端读得到（Gitee 新建分支的 raw CDN 有传播延迟）
  //    built 里只会是不健康的这几份（健康的上面已 continue，不拿新内容去覆盖正在工作的 manifest）
  for (const b of built) {
    let got = null;
    for (let i = 1; i <= 5; i++) {
      const r = await getJson(giteeRawManifestUrl(GITEE_REPO, b.name), 1);
      got = r.body?.version ?? null;
      if (got === expectedVersion) break;
      info(`回读 ${b.name}：第 ${i}/5 次读到 ${got ?? "读不到"}，${i < 5 ? `${i * 20}s 后重试` : "放弃"}`);
      if (i < 5) await sleep(i * 20000);
    }
    if (got !== expectedVersion) {
      fail(`回读 ${b.name} 失败：最终读到 ${got ?? "读不到"}，期望 ${expectedVersion}（分支存在=${branchExists}；可能是 raw CDN 未生效，或分支又被删了）`);
    }
    ok(`回读通过：${giteeRawManifestUrl(GITEE_REPO, b.name)} → version=${got}`);
  }
  note(`Gitee 通道已恢复到 ${tag}（${built.map((b) => b.name).join(", ")}）`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
