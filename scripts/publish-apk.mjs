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

function run(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, stdio: opts.quiet ? "pipe" : "inherit", shell: true, encoding: "utf8", env: { ...process.env, ...(opts.env || {}) } });
  if (r.status !== 0) fail(`${cmd} ${args.join(" ")} 失败（exit ${r.status}）：\n${r.stderr || r.stdout || ""}`);
  return r;
}

if (spawnSync("gh", ["--version"], { shell: true, stdio: "ignore" }).status !== 0) {
  fail("找不到 gh CLI（GitHub 上传依赖它，先装 gh 并 gh auth login）");
}
info(`上传 GitHub Release ${TAG}（APK + 2 份 manifest）…`);
run("gh", ["release", "upload", TAG, path.join(DIST, APK_NAME), path.join(DIST, "apk-update.json"), path.join(DIST, "apk-update-ghproxy.json"), "--clobber"]);
ok("GitHub 资产已上传");

// ─── Gitee 镜像 ──────────────────────────────────────────
// 与 release.yml 的 Gitee 段同一套实探结论：manifest 走 releases 分支 raw（小文件），
// 二进制走发行版附件 attach_files（raw 大文件要登录会 403）。

if (SKIP_GITEE) {
  info("--skip-gitee：跳过 Gitee 通道。国内用户这次更新只靠 ghproxy/GitHub 两层。");
} else {
  if (!GITEE_TOKEN) {
    fail(
      "缺少 GITEE_TOKEN 环境变量（Gitee 是三源之一，缺一即失败是设计；确实要跳过用 --skip-gitee）",
    );
  }
  // 1) manifest → releases 分支 latest/
  const mirror = mkdtempSync(path.join(tmpdir(), "pp-gitee-mirror-"));
  const giteeGit = `https://oauth2:${GITEE_TOKEN}@gitee.com/${GITEE_REPO}.git`;
  run("git", ["clone", "--depth", "1", "--branch", "releases", giteeGit, mirror], { quiet: true });
  const latest = path.join(mirror, "latest");
  if (!existsSync(latest)) fail("Gitee releases 分支里没有 latest/ 目录（镜像结构不符）");
  copyFileSync(path.join(DIST, "apk-update-gitee.json"), path.join(latest, "apk-update-gitee.json"));
  run("git", ["-C", mirror, "add", "-A", "latest"], { quiet: true });
  const commit = spawnSync("git", ["-C", mirror, "-c", "user.email=pub@pastepanda.local", "-c", "user.name=pastepanda-pub", "commit", "-m", `release: apk-update ${TAG}`], { shell: true, encoding: "utf8" });
  if (commit.status !== 0 && !/nothing to commit/.test(commit.stdout || "")) {
    fail(`Gitee manifest commit 失败：${commit.stderr || commit.stdout}`);
  }
  let push = spawnSync("git", ["-C", mirror, "push", "origin", "releases"], { shell: true, encoding: "utf8" });
  if (push.status !== 0) {
    info("第一次 push 失败，按 CI 经验用 postBuffer+--no-thin 重试…");
    push = spawnSync("git", ["-C", mirror, "-c", "http.postBuffer=524288000", "push", "--no-thin", "origin", "releases"], { shell: true, encoding: "utf8" });
    if (push.status !== 0) fail(`Gitee manifest push 两次都失败：${push.stderr || push.stdout}`);
  }
  ok("apk-update-gitee.json 已推到 releases 分支 latest/");
  rmSync(mirror, { recursive: true, force: true });

  // 2) APK → Gitee 发行版附件（attach_files 接口名，不是 GitHub 的 assets）
  const apiBase = `https://gitee.com/api/v5/repos/${GITEE_REPO}`;
  const headers = { Authorization: `token ${GITEE_TOKEN}` };
  const sha = spawnSync("git", ["rev-parse", TAG], { cwd: ROOT, shell: true, encoding: "utf8" }).stdout?.trim();
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

  // 3) 回读确认资产里真有（防假绿，CI 同款教训）
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
    manifestUrl = `https://gitee.com/${GITEE_REPO}/raw/releases/latest/${m.file}`;
  } else {
    const direct = `https://github.com/${GH_REPO}/releases/latest/download/${m.file}`;
    manifestUrl = m.file === "apk-update.json" ? direct : `https://ghproxy.net/${direct}`;
  }
  checks.push({ label: m.file, manifestUrl, apkUrl });
}

for (const c of checks) {
  let body = null;
  for (let i = 1; i <= 4 && !body; i++) {
    try {
      const r = await fetch(c.manifestUrl, { redirect: "follow" });
      if (r.ok) body = await r.json();
    } catch {}
    if (!body) await sleep(i * 8000); // Gitee 新分支 raw CDN 有传播延迟（CI 实测）
  }
  if (!body) fail(`回读失败：${c.label} 的 manifest 多次重试仍读不到（${c.manifestUrl}）`);
  if (body.version !== VERSION) fail(`回读不一致：${c.label} manifest version=${body.version}，期望 ${VERSION}`);
  if (body.sha256 !== sha256) fail(`回读不一致：${c.label} manifest sha256 与本地 APK 不符`);
  const st = await getRange(c.apkUrl).catch(() => 0);
  if (st !== 200 && st !== 206) fail(`回读失败：${c.label} 的 APK 取不到（HTTP ${st}）：${c.apkUrl}`);
  ok(`${c.label}: manifest 可读且一致，APK 可下（HTTP ${st}）`);
}

ok(`v${VERSION} Android ${SKIP_GITEE ? "两源（GitHub/ghproxy，本次跳过 Gitee）" : "三源"}发布完成。客户端下次检查（≤24h）即可发现更新。`);
