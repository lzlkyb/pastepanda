#!/usr/bin/env node
/**
 * repair-gitee-channel.mjs — Gitee 更新通道的自检 + 自愈。
 *
 * 问题：客户端第 1 条更新源指向 `https://gitee.com/<repo>/raw/releases/latest/updater-gitee.json`，
 * 它落在 `releases` 分支的 latest/ 目录上。2026-10-10 定性：这条分支以前手工建在 **Gitee** 上，
 * 而 Gitee 的「仓库镜像管理」同步 GitHub 的整个分支集合、并「删除在远程仓库中不存在的分支和标签」
 * ⇒ 每推一次 GitHub 就剪一次，通道跟着 404（v7.2.9/v7.2.10 日志里连续两版都是 `[new branch]` 即此）。
 * 现在分支建在 GitHub 上，manifest 也只推 GitHub（见 scripts/publish-manifest-branch.mjs），镜像替我们
 * 搬到 Gitee。本脚本仍只做一件事：**发现 Gitee 读不到（或读到过期版本）就补回去**。
 *
 * 为什么能纯派生、不需要重新构建：
 *   Gitee 源和 GitHub 直连源用的是**同一个 exe、同一份 minisign 签名**，只有取文件那条 URL 的
 *   主机不同（见 release.yml 里 UPDATER_URL_TEMPLATE 那段注释）。所以从 GitHub Release 上已经
 *   发布的 updater.json / apk-update.json 换 host，就是发版时生成的那份的等价物。
 *
 * 环境变量：
 *   GITEE_TOKEN       可选，只用来提 Gitee API 配额（发行版附件清单）；**manifest 推送不再需要它**
 *   GITEE_REPOSITORY  默认 lzul/pastepanda —— 必须与客户端硬编码的仓库一致，脚本会打印它
 *   GH_REPO           默认 lzlkyb/pastepanda
 *   GH_TOKEN / GITHUB_TOKEN  GitHub 写令牌（推送必需；CI 用 secrets.GITHUB_TOKEN，本地留空则取 gh auth token）
 *   GH_TAG            可选，指定要恢复的 tag；留空 = GitHub 最新 Release
 *   DRY_RUN           =1 时只诊断 + 生成本地产物，不推送
 *
 * 🔴 为什么「版本对不上」必须硬失败，而不是「能读到就算好」：
 *   update.rs:367-370 的语义是 —— manifest 读得到但版本不比当前新，就 `return Ok(None)`
 *   判「已是最新版本」，**后面的源不再试**。所以把一条过期 manifest 补回 Gitee 比 404 更糟：
 *   404 至少会降级到 ghproxy/GitHub，过期 manifest 会让用户彻底收不到更新。
 *   同理，指向不存在附件的 manifest 也不许发出去（第 3 步：Gitee 发行版 API 清单为主、
 *   Range 直链探测为辅 —— runner 到 Gitee 下载域名经常连不上，只看直链会永远卡死）。
 */

import { spawnSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MANIFEST_BRANCH, giteeRawManifestUrl, publishManifestBranch, verifyChannel } from "./publish-manifest-branch.mjs";

// 客户端读的那个地址由发布出口定义，这里只转发（三处各拼一遍是 2026-10-08 那类「修复在修没人读的路径」的源头）
export { giteeRawManifestUrl };

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

/** GitHub 写令牌：CI 传 GITHUB_TOKEN，本地留空则取 gh 的登录态。 */
function ghWriteToken() {
  const fromEnv = (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "").trim();
  if (fromEnv) return fromEnv;
  const r = spawnSync("gh", ["auth", "token"], { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "";
}

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

async function getJson(url, tries = 3, label = url) {
  let last = "未执行";
  // 最后一轮拿到过的 HTTP 状态码。它必须活着传出去：读不到时调用方要分清
  // 「Gitee/GitHub 说没有这个文件」（404/403，否定证据）和「这台机器此刻连不上」
  // （0 / 超时 / 5xx，什么都不能证明）。一律压成 status=0 会让前者永远判不出来。
  let lastStatus = 0;
  for (let i = 1; i <= tries; i++) {
    try {
      const r = await fetch(url, {
        redirect: "follow",
        headers: GH_TOKEN && url.startsWith("https://api.github.com/") ? { Authorization: `Bearer ${GH_TOKEN}` } : {},
      });
      if (!r.ok) {
        last = `HTTP ${r.status}`;
        lastStatus = r.status;
      } else {
        const body = await r.json().catch(() => null);
        if (body === null) throw new Error(`响应不是 JSON（大概率是被重定向到的网页）：${label}`);
        return { body, status: r.status };
      }
    } catch (e) {
      last = String(e?.message || e);
      lastStatus = 0;
    }
    if (i < tries) await sleep(i * 3000);
  }
  return { body: null, status: lastStatus, error: last };
}

/** 发行版附件清单（判定「包在不在」的第一手证据）。取不到返回 null，不判否定。 */
async function fetchGiteeAssetUrls() {
  const apiUrl = giteeReleasesApiUrl(GITEE_REPO, GITEE_TOKEN);
  const r = await getJson(apiUrl, 3, sanitizeUrl(apiUrl));
  if (!Array.isArray(r.body)) {
    warn(`Gitee 发行版清单没拿到（${r.error || r.status}）：本轮只能靠直链状态码判定`);
    return null;
  }
  const set = new Set();
  for (const rel of r.body) {
    for (const a of rel?.assets || []) {
      if (a?.browser_download_url) set.add(a.browser_download_url);
    }
  }
  info(`Gitee 发行版清单：${r.body.length} 个发行版 / ${set.size} 条下载地址`);
  return set;
}

/** 探测附件直链的 HTTP 状态码；连不上返回 0（这是「没探到」，不是「不存在」）。 */
async function probeAssetStatus(url) {
  try {
    const r = await fetch(url, { method: "GET", headers: { Range: "bytes=0-1023" }, redirect: "follow" });
    return r.status;
  } catch {
    return 0;
  }
}

/**
 * Gitee 发行版附件清单的地址。API 返回的 `assets[].browser_download_url` 就是
 * `https://gitee.com/{repo}/releases/download/{tag}/{file}` 形态，与 manifest 里那条
 * 同形可比对（2026-10-08 实测）。`per_page` 不给就只返回 20 条，最新那个发行版
 * 会掉在页外面（同一天的实测：不带 per_page 时列表里根本没有 v7.2.10）。
 */
export function giteeReleasesApiUrl(repo, token) {
  const base = `https://gitee.com/api/v5/repos/${repo}/releases?per_page=100`;
  return token ? `${base}&access_token=${token}` : base;
}

/** 令牌只进请求，不进任何一行日志。 */
export function sanitizeUrl(u) {
  return String(u).replace(/access_token=[^&\s]*/g, "access_token=***");
}

/**
 * 「这条 manifest 指向的包能不能放行」的判定（纯函数，无网络，口径可单测）。
 * inAssetList：true = 发行版清单里有这条地址；false = 清单拿到了且没有；
 * null = 清单本身没取到（此时只能看直链状态码，不能凭空造结论）。
 * 🔴 证据分级：404 是否定证据，0 / 5xx 只是「这台机器此刻探不到」——GitHub 的 runner
 * 到 Gitee 下载直链就经常连不上（2026-10-08 CI 实测 HTTP 0），只靠直链会把自愈永远卡死。
 * 而 Gitee 自己的发行版 API 会把 `browser_download_url` 原样列出来，与 manifest 里那条
 * 逐字可比（同天实测），所以「清单命中」就是来自 Gitee 的第一手存在性证据。
 * 403 单独一档：它是访问裁决不是存在性证据（境外 runner 撞防盗链就吃 403），清单命中时放行。
 */
export function assetVerdict({ status, inAssetList }) {
  if (status === 200 || status === 206) return "ok";
  if (status === 404) return "missing";
  if (status === 403) return inAssetList === true ? "ok" : "missing";
  if (inAssetList === true) return "ok";
  if (inAssetList === false) return "missing";
  return "unproven";
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
    // reason 必须是探针实际读到的东西：把它笼统写成「404」会把一次 fetch failed
    // 记成「文件不存在」那样的否定证据（2026-10-08 CI 就出现过：日志说 fetch
    // failed，annotation 却说读到 404）。
    const reason = probe.body ? `读到 version=${got}` : `读不到（${probe.error || `HTTP ${probe.status}`}）`;
    state[t.name] = { healthy: got === expectedVersion, got, raw: probe, reason };
    info(`探针 ${t.name}: ${reason} → ${state[t.name].healthy ? "健康" : "需修复"}`);
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
    `需修复=${TARGETS.filter((t) => !state[t.name].healthy).map((t) => `${t.name}：${state[t.name].reason}`).join(", ")}` +
      `｜releases 分支存在=${branchExists}｜匿名可见分支=${anonLs.join(",") || "(空)"}`,
  );

  // 3) 从 GitHub 已发布的 manifest 派生
  //    先把 Gitee 侧的附件清单取回来（存在性证据，只用一次请求覆盖全部待验地址）。
  //    放在修复分支里而不是开头：两份都健康时上面已经 return，不必多打一次 API。
  const assetUrls = await fetchGiteeAssetUrls();
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
    const unproven = [];
    for (const url of urls) {
      const st = await probeAssetStatus(url);
      const inList = assetUrls ? assetUrls.has(url) : null;
      const verdict = assetVerdict({ status: st, inAssetList: inList });
      if (verdict === "missing") {
        missing.push(`直链 HTTP ${st}${inList === false ? "、发行版清单里也没有" : ""}`);
        warn(`Gitee 附件判定为缺（${missing[missing.length - 1]}）：${url}`);
      } else if (verdict === "unproven") {
        // 直链探不通、清单又没拿到 —— 两份证据都缺席，此时无论判「在」还是「不在」都是编的。
        unproven.push(`HTTP ${st}`);
      } else if (st !== 200 && st !== 206) {
        ok(`附件在 Gitee 发行版清单里（直链探测 HTTP ${st}，是这台 runner 到 Gitee 的连通性问题，不是文件不存在）：${url}`);
      } else {
        ok(`附件可下（HTTP ${st}）：${url}`);
      }
    }
    if (unproven.length) {
      fail(
        `${t.name}：探测 Gitee 附件时既没探到直链、也没拿到发行版清单（${unproven.join(", ")}）。\n` +
          `  两种判法都缺证据，本轮不猜。等下一轮自愈（定时档 17 与 47 分，一小时两次）。`,
      );
    }
    if (missing.length) {
      skipped.push(
        `${t.name}：manifest 指向的包不在 Gitee 发行版附件里（${missing.join(", ")}）。` +
          `补救 = 重跑发版 CI 的「上传安装包到 Gitee 发行版」/ android.yml 的三源发布，或本地 tools/upload-exe-to-gitee.ps1 -Version ${expectedVersion}`,
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
  // 4) 提交到 GitHub 的 releases 分支
  //    唯一出口是 scripts/publish-manifest-branch.mjs：只 FF 提交、只点名自己那几份文件、
  //    不清空 latest/。以前这里手工推 Gitee 的孤儿分支，而镜像同步会剪「上游没有的分支」
  //    ⇒ 修好一次、下一次 GitHub push 又剪掉一次（2026-10-10 定性）。
  const ghToken = ghWriteToken();
  if (!ghToken) fail("缺少 GitHub 写令牌（CI 用 secrets.GITHUB_TOKEN，本地用 gh auth token；只想看诊断用 DRY_RUN=1）");
  let pushedSha;
  try {
    pushedSha = publishManifestBranch({
      repo: GH_REPO,
      token: ghToken,
      files: built.map((b) => path.join(outDir, b.name)),
      identity: { email: "ci@pastepanda.local", name: "pastepanda-ci" },
    }).sha;
  } catch (e) {
    fail(`提交到 GitHub ${MANIFEST_BRANCH} 分支失败：${e?.message ?? e}`);
  }

  // 5) 三段验证：GitHub sha → Gitee 分支 sha → Gitee raw 读得到且版本对
  //    推上去 ≠ 客户端读得到；卡在哪一段就打印哪一段，不再一句「读不到」把三种成因混成一团。
  //    built 里只会是不健康的这几份（健康的上面已 continue，不拿新内容去覆盖正在工作的 manifest）
  const expectedVersions = {};
  for (const b of built) expectedVersions[b.name] = expectedVersion;
  try {
    await verifyChannel({ ghRepo: GH_REPO, giteeRepo: GITEE_REPO, pushedSha, expected: expectedVersions });
  } catch (e) {
    fail(`三段验证未通过（分支存在=${branchExists}）：${e?.message ?? e}`);
  }
  note(`Gitee 通道已恢复到 ${tag}（${built.map((b) => b.name).join(", ")}）`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await main();
}
