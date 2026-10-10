#!/usr/bin/env node
/**
 * publish-apk.mjs — Android 自更新（方案甲）三源发布 + 回读验证（第一阶段入口）。
 *
 * 用法（在打完 release APK 之后、按 docs/发版流程.md 顺序执行）：
 *   npm run android:apk:release                      # 本地打签名 APK
 *   node scripts/publish-apk.mjs                     # 生成三份 manifest → 上传 GitHub/Gitee → 三源回读验证
 *   node scripts/publish-apk.mjs --dry-run           # 只生成本地产物，不上传不验证
 *   node scripts/publish-apk.mjs --apk <path>        # 指定 APK 路径（默认 gen/android release 产物）
 *
 * 环境变量：
 *   GITEE_TOKEN        Gitee API/git push 令牌（缺省则跳过 Gitee 通道并红灯——
 *                      三源缺一即失败是设计，不静默降级；确要跳过用 --skip-gitee）
 *   GITEE_REPOSITORY   默认 lzul/pastepanda（与 tauri.conf.json updater.endpoints 同仓库）
 *   GITHUB_REPOSITORY  默认 lzlkyb/pastepanda
 *   PP_APK_NOTES       覆盖更新说明（默认调 extract-release-notes.mjs 提取，单一来源）
 *
 * 前置：GitHub Release（tag v{version}）已由发版 CI 创建——本脚本只补传 APK 资产
 * 与 manifest，不创建 Release。
 *
 * 🔴 为什么回读验证是硬闸：客户端「发现新版 → 下载 404」就是桌面 v7.1.1 的事故形态
 * （manifest 与二进制不同主机/漏传）。这里任何一源「manifest 读不到 / version 不匹配 /
 * APK Range 下载失败」都 exit 1，宁可发版红灯，不做静默半发布。
 */

import { spawnSync } from "node:child_process";
import crypto from "node:crypto";
import {
  copyFileSync,
  createReadStream,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_RETRY_WAITS, MANIFEST_BRANCH, giteeRawManifestUrl, publishManifestBranch } from "./publish-manifest-branch.mjs";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

// ─── 配置 ────────────────────────────────────────────────

const argv = process.argv.slice(2);
const flag = (name) => argv.includes(`--${name}`);
const opt = (name, def) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : def;
};
const DRY_RUN = flag("dry-run");
const SKIP_GITEE = flag("skip-gitee");

const GH_REPO = process.env.GITHUB_REPOSITORY || "lzlkyb/pastepanda";
const GITEE_REPO = process.env.GITEE_REPOSITORY || "lzul/pastepanda";
const GITEE_TOKEN = process.env.GITEE_TOKEN || "";

const conf = JSON.parse(readFileSync(path.join(ROOT, "src-tauri", "tauri.conf.json"), "utf-8"));
const VERSION = conf.version;
const TAG = `v${VERSION}`;
const APK_NAME = `PastePanda_${VERSION}_universal-release.apk`;

const DEFAULT_APK = path.join(
  ROOT,
  "src-tauri",
  "gen",
  "android",
  "app",
  "build",
  "outputs",
  "apk",
  "universal",
  "release",
  "app-universal-release.apk",
);
const APK_PATH = path.resolve(ROOT, opt("apk", DEFAULT_APK));

const DIST = path.join(ROOT, "dist", "apk");

function fail(msg) {
  console.error(`\x1b[31m[publish-apk ERROR]\x1b[0m ${msg}`);
  process.exit(1);
}
function info(msg) {
  console.log(`\x1b[36m[publish-apk]\x1b[0m ${msg}`);
}
function ok(msg) {
  console.log(`\x1b[32m[publish-apk OK]\x1b[0m ${msg}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ─── 产物生成 ────────────────────────────────────────────

if (!DRY_RUN && !existsSync(APK_PATH)) {
  fail(`APK 不存在：${APK_PATH}\n  先跑 npm run android:apk:release，或用 --apk 指定路径`);
}
if (!existsSync(APK_PATH)) {
  fail(`APK 不存在（--dry-run 也需要有包）：${APK_PATH}`);
}
const apkSize = statSync(APK_PATH).size;
if (apkSize < 5 * 1024 * 1024) {
  fail(`APK 只有 ${apkSize} 字节，不像是完整 release 包（<5MB 直接拒）`);
}

const sha256 = await new Promise((res, rej) => {
  const h = crypto.createHash("sha256");
  createReadStream(APK_PATH)
    .on("data", (d) => h.update(d))
    .on("end", () => res(h.digest("hex")))
    .on("error", rej);
});
info(`APK: ${APK_PATH}`);
info(`大小: ${(apkSize / 1024 / 1024).toFixed(1)} MB  sha256: ${sha256}`);

// notes 单一来源：调 extract-release-notes.mjs（与桌面 updater.json 同一段 CHANGELOG），
// 经临时 GITHUB_OUTPUT 文件拿回 updater_notes，不复制它的解析逻辑。
let notes = process.env.PP_APK_NOTES || "";
if (!notes) {
  const outFile = path.join(mkdtempSync(path.join(tmpdir(), "pp-apk-notes-")), "gh_output");
  const r = spawnSync("node", ["scripts/extract-release-notes.mjs", VERSION], {
    cwd: ROOT,
    env: { ...process.env, GITHUB_OUTPUT: outFile },
    encoding: "utf8",
  });
  if (r.status !== 0) {
    fail(`提取 CHANGELOG 段落失败（v${VERSION} 可能没有日志段）：\n${r.stderr || r.stdout}`);
  }
  const raw = readFileSync(outFile, "utf8");
  const m = raw.match(/^updater_notes<<CHANGELOG_EOF\n([\s\S]*?)\nCHANGELOG_EOF$/m);
  if (!m) fail("extract-release-notes 输出里没解析到 updater_notes");
  notes = m[1];
  rmSync(path.dirname(outFile), { recursive: true, force: true });
}

const ghUrl = (name) => `https://github.com/${GH_REPO}/releases/download/${TAG}/${name}`;
const manifests = [
  {
    file: "apk-update.json",
    body: { version: VERSION, notes, pub_date: new Date().toISOString(), url: ghUrl(APK_NAME), sha256 },
  },
  {
    file: "apk-update-ghproxy.json",
    body: {
      version: VERSION,
      notes,
      pub_date: new Date().toISOString(),
      url: `https://ghproxy.net/${ghUrl(APK_NAME)}`,
      sha256,
    },
  },
  {
    file: "apk-update-gitee.json",
    body: {
      version: VERSION,
      notes,
      pub_date: new Date().toISOString(),
      url: `https://gitee.com/${GITEE_REPO}/releases/download/${TAG}/${APK_NAME}`,
      sha256,
    },
  },
];

// 本地自检（对齐 verify-updater-json 的判据：版本/notes/url 缺一红灯）
for (const m of manifests) {
  if (m.body.version !== VERSION) fail(`${m.file}: version 与 tauri.conf.json 不一致`);
  if (!m.body.notes || !m.body.notes.split(/\r?\n/).some((l) => /^- /.test(l.trim()))) {
    fail(`${m.file}: notes 没有 "- " 条目，疑似提取失败`);
  }
  if (!m.body.url.startsWith("https://")) fail(`${m.file}: url 必须是 https`);
}

const outDir = DRY_RUN ? path.join(ROOT, "dist", "apk-dryrun") : DIST;
rmSync(outDir, { recursive: true, force: true });
mkdirSync(outDir, { recursive: true });
for (const m of manifests) {
  writeFileSync(path.join(outDir, m.file), JSON.stringify(m.body, null, 2));
}
copyFileSync(APK_PATH, path.join(outDir, APK_NAME));
ok(`已生成 ${manifests.length} 份 manifest + APK 副本 → ${outDir}`);
if (DRY_RUN) {
  info("--dry-run：不上传、不验证。产物在 dist/apk-dryrun/");
  process.exit(0);
}

// ─── GitHub 上传 ─────────────────────────────────────────

// 🔴 这里的调用一律不开 shell 选项：Node 开了 shell 不转义 args，只是把它们**拼接**成一条
//    命令串（Node 24 运行时就有 DEP0190 警告）。带空格的参数会被拆成多个 argv——
//    2026-10-09 首跑真实发布就是这么炸的：`-m "release: apk-update v7.2.11"` 到了 git 变成
//    message=`release:` + 两个 pathspec，报 `pathspec 'apk-update' did not match any file(s)`；
//    本机 Windows 用同一份 argv 复现出完全相同的两行错误（不只是 Linux 的问题）。
//    钉这条守卫的是 src/__tests__/publishApkReleaseFailures.test.ts。
//    Windows 上 `gh` / `git` 都是真 .exe，不靠 shell 也能解析（已实测），所以这里没有
//    「.bat 必须走 shell」的约束——那个约束只在 android-build.mjs 的 apksigner.bat 上成立。
function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: opts.quiet ? "pipe" : "inherit", encoding: "utf8", env: { ...process.env, ...(opts.env || {}) } });
  if (r.status !== 0) fail(`${cmd} ${args.join(" ")} 失败（exit ${r.status}）：\n${r.stderr || r.stdout || ""}`);
  return r;
}

/** GitHub 写令牌：manifest 现在提交到 GitHub 的 releases 分支，本地发布走 gh 的登录态。 */
function ghAuthToken() {
  const fromEnv = (process.env.GH_TOKEN || process.env.GITHUB_TOKEN || "").trim();
  if (fromEnv) return fromEnv;
  const r = spawnSync("gh", ["auth", "token"], { encoding: "utf8" });
  if (r.status !== 0) fail("gh auth token 失败（manifest 要提交到 GitHub releases 分支，先 gh auth login）");
  return r.stdout.trim();
}

if (spawnSync("gh", ["--version"], { stdio: "ignore" }).status !== 0) {
  fail("找不到 gh CLI（GitHub 上传依赖它，先装 gh 并 gh auth login）");
}
info(`上传 GitHub Release ${TAG}（APK + 2 份 manifest）…`);
run("gh", ["release", "upload", TAG, path.join(DIST, APK_NAME), path.join(DIST, "apk-update.json"), path.join(DIST, "apk-update-ghproxy.json"), "--clobber"]);
ok("GitHub 资产已上传");

// ─── Gitee 通道 ──────────────────────────────────────────
// 与 release.yml 同一套实探结论：**manifest 不再手工推 Gitee**，改为提交到 GitHub 的
// `releases` 分支，由 Gitee 的「仓库镜像管理」搬运（实测同步 4–11s，raw 边缘再 20–100s）。
// 以前它在 Gitee 上是手工建的孤儿分支，而镜像同步按「删除在远程仓库中不存在的分支和标签」
// 剪枝 ⇒ 每推一次 GitHub 就剪一次，客户端第 1 更新源跟着 404（2026-10-10 实测时间链）。
// 二进制仍然走 Gitee 发行版附件 attach_files（raw 大文件要登录会 403），那需要 GITEE_TOKEN。

if (SKIP_GITEE) {
  info("--skip-gitee：跳过 Gitee 通道。国内用户这次更新只靠 ghproxy/GitHub 两层。");
} else {
  if (!GITEE_TOKEN) {
    fail(
      "缺少 GITEE_TOKEN 环境变量（Gitee 是三源之一，缺一即失败是设计；确实要跳过用 --skip-gitee）",
    );
  }
  // 1) APK → Gitee 发行版附件（attach_files 接口名，不是 GitHub 的 assets）
  const apiBase = `https://gitee.com/api/v5/repos/${GITEE_REPO}`;
  const headers = { Authorization: `token ${GITEE_TOKEN}` };
  const sha = spawnSync("git", ["rev-parse", TAG], { cwd: ROOT, encoding: "utf8" }).stdout?.trim();
  let rel = null;
  try {
    const resp = await fetch(`${apiBase}/releases/tags/${TAG}`, { headers });
    if (resp.ok) rel = await resp.json();
  } catch {}
  if (!rel?.id) {
    const created = await fetch(`${apiBase}/releases`, {
      method: "POST",
      headers: { ...headers, "Content-Type": "application/json" },
      body: JSON.stringify({ tag_name: TAG, name: `PastePanda ${TAG}`, body: `PastePanda ${TAG}（apk 自动发布）`, prerelease: false, target_commitish: sha || "master" }),
    });
    if (!created.ok) fail(`创建 Gitee 发行版失败：HTTP ${created.status} ${await created.text()}`);
    rel = await created.json();
  }
  info(`Gitee 发行版 id=${rel.id}，上传 APK 附件（几十 MB，可能要几分钟）…`);
  const form = new FormData();
  const buf = readFileSync(path.join(DIST, APK_NAME));
  form.append("file", new Blob([buf], { type: "application/vnd.android.package-archive" }), APK_NAME);
  const up = await fetch(`${apiBase}/releases/${rel.id}/attach_files`, { method: "POST", headers, body: form });
  if (!up.ok) fail(`attach_files 上传失败：HTTP ${up.status} ${(await up.text()).slice(0, 400)}`);
  ok("APK 已挂到 Gitee 发行版");

  // 2) 回读确认资产里真有（防假绿，CI 同款教训）
  let found = false;
  for (let i = 1; i <= 4 && !found; i++) {
    const chk = await fetch(`${apiBase}/releases/${rel.id}`, { headers });
    if (chk.ok) {
      const j = await chk.json();
      found = (j.assets || []).some((a) => (a.name || a.label || "").includes(APK_NAME));
    }
    if (!found) await sleep(i * 5000);
  }
  if (!found) fail("Gitee 发行版附件里回读不到 APK（上传假绿？）");
  ok("Gitee 附件回读通过");

  // 3) manifest → GitHub 的 releases 分支（放在附件之后：manifest 一旦上线，
  //    里面那条 releases/download/{tag}/{APK} 必须已经可下，否则客户端就是「发现新版 → 下载 404」）
  try {
    publishManifestBranch({ repo: GH_REPO, token: ghAuthToken(), files: [path.join(DIST, "apk-update-gitee.json")] });
  } catch (e) {
    fail(
      `apk-update-gitee.json 提交到 GitHub ${MANIFEST_BRANCH} 分支失败：${e?.message ?? e}\n` +
        `  Gitee 那份 manifest 这次不会更新（老那份仍留在分支上，客户端会降级到 ghproxy/GitHub）。`,
    );
  }
}

// ─── 三源回读验证（发布后冒烟，缺一源红灯）──────────────

async function getRange(url, ms = 30000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), ms);
  try {
    const r = await fetch(url, { headers: { Range: "bytes=0-1023" }, redirect: "follow", signal: ctrl.signal });
    return r.status;
  } finally {
    clearTimeout(t);
  }
}

const checks = [];
for (const m of manifests) {
  // --skip-gitee：未发布 Gitee 源，回读也一并跳过（否则必然 404 → 假红灯）
  if (SKIP_GITEE && m.file === "apk-update-gitee.json") continue;
  let manifestUrl;
  let apkUrl = m.body.url;
  if (m.file === "apk-update-gitee.json") {
    // 与发布出口、repair 脚本、客户端硬编码端点同一份地址构造，别各处自己拼一边。
    manifestUrl = giteeRawManifestUrl(GITEE_REPO, m.file);
  } else {
    const direct = `https://github.com/${GH_REPO}/releases/latest/download/${m.file}`;
    manifestUrl = m.file === "apk-update.json" ? direct : `https://ghproxy.net/${direct}`;
  }
  checks.push({ label: m.file, manifestUrl, apkUrl });
}

for (const c of checks) {
  let body = null;
  // 等待档必须盖住「镜像同步 + raw 边缘传播」两段实测延迟（同步 4–11s，raw 见过 20–100s、最坏 4 分钟）。
  // 2026-10-10 改道之后 manifest 推的是 GitHub 的 releases 分支，Gitee 那份由镜像搬运，
  // 所以这里比的不是「我们刚推完」而是「搬到了没有」。等待档一旦短于传播延迟，
  // 就会在「其实已经发布成功」的最后一步判红——而红了一轮就得重来、再把线上 APK clobber 一次。
  const total = DEFAULT_RETRY_WAITS.length + 1;
  for (let i = 1; i <= total && !body; i++) {
    try {
      const r = await fetch(c.manifestUrl, { redirect: "follow" });
      if (r.ok) body = await r.json();
    } catch {}
    if (!body && i <= DEFAULT_RETRY_WAITS.length) await sleep(DEFAULT_RETRY_WAITS[i - 1] * 1000);
  }
  if (!body) fail(`回读失败：${c.label} 的 manifest 多次重试仍读不到（${c.manifestUrl}）`);
  if (body.version !== VERSION) fail(`回读不一致：${c.label} manifest version=${body.version}，期望 ${VERSION}`);
  if (body.sha256 !== sha256) fail(`回读不一致：${c.label} manifest sha256 与本地 APK 不符`);
  // 附件同理：attach_files 返回 200 ≠ 直链立刻可下。
  let st = 0;
  for (let i = 1; i <= 3 && st !== 200 && st !== 206; i++) {
    st = await getRange(c.apkUrl).catch(() => 0);
    if (st !== 200 && st !== 206 && i < 3) await sleep(i * 20000);
  }
  if (st !== 200 && st !== 206) fail(`回读失败：${c.label} 的 APK 取不到（HTTP ${st}）：${c.apkUrl}`);
  ok(`${c.label}: manifest 可读且一致，APK 可下（HTTP ${st}）`);
}

ok(`v${VERSION} Android ${SKIP_GITEE ? "两源（GitHub/ghproxy，本次跳过 Gitee）" : "三源"}发布完成。客户端下次检查（≤24h）即可发现更新。`);
