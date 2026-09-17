#!/usr/bin/env node
/**
 * sync-manual-version.mjs
 *
 * 构建前把 tauri.conf.json 的版本号同步到 docs/manual/*.html 的「当前版本」展示位。
 *
 * 设计原则：
 *   - tauri.conf.json 是版本号唯一来源（与 sync-version.mjs 一致）。
 *   - GitHub Pages 直接读 master 分支的 /docs/manual/*.html，仓库里必须是真实版本号；
 *     因此本脚本采用「上下文精准替换」：只覆盖下载链接 / 品牌版本 / 顶栏版本 /
 *     最新版本文字 这几个「当前版本」位置，绝不动历史时间线（tl-v）里的旧版本号。
 *   - 幂等：每次都按 conf 当前版本覆盖这些位置，重复运行不报错；不依赖任何占位符
 *     （占位符会被提交消耗，下次无法再注入，故不采用全局占位符方案）。
 *
 * Usage:  node scripts/sync-manual-version.mjs
 *         （已挂入 npm run prebuild）
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");

const CONF_PATH = path.join(ROOT, "src-tauri", "tauri.conf.json");
const MANUAL_DIR = path.join(ROOT, "docs", "manual");
const TARGETS = ["index.html", "_baseline.html", "manual.html"];

function fail(msg) {
  console.error(`\x1b[31m[SYNC-MANUAL-VERSION ERROR]\x1b[0m ${msg}`);
  process.exit(1);
}
function info(msg) {
  console.log(`\x1b[36m[SYNC-MANUAL-VERSION]\x1b[0m ${msg}`);
}
function success(msg) {
  console.log(`\x1b[32m[SYNC-MANUAL-VERSION OK]\x1b[0m ${msg}`);
}

// 1. 读取 tauri.conf.json 版本（唯一来源）
if (!fs.existsSync(CONF_PATH)) {
  fail(`找不到 tauri.conf.json: ${CONF_PATH}`);
}
const conf = JSON.parse(fs.readFileSync(CONF_PATH, "utf-8"));
const version = conf.version;
if (!version) {
  fail("tauri.conf.json 中未找到 version 字段");
}
info(`目标版本: ${version}`);

// 2. 先算 Gitee 真实下载地址：优先 canonical attach_files（浏览器直链可用），
//    失败（离线/API 异常）则回退到 release tag 页（用户实测可点下载）。
//    原因：Gitee 的 /releases/download/{tag}/ 直链在「带 Referer 的浏览器场景」
//    会 404，只有真实的 /attach_files/{id}/download/ 才能在浏览器直接下载。
let giteeUrl;
let giteeOk = false;
{
  const fallback = `https://gitee.com/lzul/pastepanda/releases/tag/v${version}`;
  try {
    const rel = await (await fetch(`https://gitee.com/api/v5/repos/lzul/pastepanda/releases/tags/v${version}`)).json();
    const rid = rel.id;
    const files = rid ? await (await fetch(`https://gitee.com/api/v5/repos/lzul/pastepanda/releases/${rid}/attach_files`)).json() : [];
    /* ❗ 文件名必须兼容「带 v / 不带 v」两种。
     * CI 推到 Gitee 的资产名是 PastePanda_7.1.4_x64-setup.exe（**无 v**），
     * 而 GitHub 侧是 PastePanda_v7.1.4_x64-setup.exe（**有 v**）。早先这里只按带 v 匹配，
     * 于是永远取不到 asset → giteeOk=false → 再撞上下面「保留原 attach_files 链接」的降级，
     * 版本号被永久冻结在最后一次成功写入的那一版（v6.18.5），而界面上却写着 v7.1.4。
     * 真实文件名以 API 返回的 name 为准，别自己拼。 */
    const WANT = [`PastePanda_${version}_x64-setup.exe`, `PastePanda_v${version}_x64-setup.exe`];
    const asset = Array.isArray(files) ? files.find((a) => WANT.includes(a.name)) : null;
    if (asset && asset.id) {
      giteeUrl = `https://gitee.com/lzul/pastepanda/attach_files/${asset.id}/download/${asset.name}`;
      giteeOk = true;
      info(`Gitee 直链(canonical): ${giteeUrl}`);
    } else {
      giteeUrl = fallback;
      info(`Gitee API 未取到附件，回退到 release 页: ${fallback}`);
    }
  } catch (e) {
    info(`Gitee API 获取失败，回退到 release 页: ${e.message}`);
    giteeUrl = fallback;
  }
}

// 3. 只匹配「当前版本」上下文，跳过历史时间线（tl-v 里的旧版本号）
// 版本迭代计数：以 CHANGELOG.md 实际已发布版本数为准（排除 [Unreleased]）。
// hero 的「N 个版本持续迭代」是营销口径，必须跟着仓库真实节奏走——
// 早先手填「80」，2026-09 时实际已 89 个，硬编码必然持续腐化，改由这里注入。
// CHANGELOG 缺失时该规则跳过、保留原文，不阻塞构建。
let releaseCount = null;
{
  const clPath = path.join(ROOT, "CHANGELOG.md");
  if (fs.existsSync(clPath)) {
    const cl = fs.readFileSync(clPath, "utf-8");
    releaseCount = (cl.match(/^## \[\d+\.\d+\.\d+\]/gm) || []).length;
    if (releaseCount) info(`CHANGELOG 已发布版本数: ${releaseCount}`);
  }
}
const rules = [
  {
    name: "GitHub 下载链接",
    // ❗ 目录是 tag（带 v），文件名**不带 v**：CI 从 v7.0.0 起资产名一直是
    // `PastePanda_7.1.4_x64-setup.exe`。早先这里文件名也写成 PastePanda_v${version}，
    // 于是首页主下载按钮直接 404（2026-09-09 实测：带 v 404、不带 v 302）。
    // 两侧都以真实资产名为准，别自己拼。
    re: /https:\/\/github\.com\/lzlkyb\/pastepanda\/releases\/download\/v?\d+\.\d+\.\d+\/PastePanda_v?\d+\.\d+\.\d+_x64-setup\.exe/g,
    repl: () => `https://github.com/lzlkyb/pastepanda/releases/download/v${version}/PastePanda_${version}_x64-setup.exe`,
  },
  {
    name: "Gitee 下载链接（canonical attach_files，浏览器可用）",
    // 同时匹配旧 releases/download 形态与新 attach_files 形态，便于跨版本同步。
    // API 成功 → 写入 canonical 直链；API 失败 → **无条件回退到 release tag 页**。
    // ❗ 绝不保留文件里原有的 attach_files 链接：那条链接自带旧版本号和旧 id，
    //    留着就等于让首页长期分发过期安装包（v6.18.5 那次就是这么来的）。
    //    tag 页至少指向最新版，宁可多点一下也不能给错版本。
    re: /https:\/\/gitee\.com\/lzul\/pastepanda\/(?:releases\/download\/v?\d+\.\d+\.\d+|attach_files\/\d+\/download)\/PastePanda_v?\d+\.\d+\.\d+_x64-setup\.exe/g,
    repl: () => giteeUrl,
  },
  {
    name: "Gitee 下载链接（tag 页降级形态）",
    // ❗ 上一条规则只认 releases/download 与 attach_files 两种形态，而降级分支写进去的
    //    恰恰是第三种：**releases/tag/{tag}**。于是「先降级、等 CI 出包后再同步成直链」
    //    这条路根本走不通——降级一次之后这条链接再也匹配不到任何规则，版本号被永久冻结。
    //    （2026-09-17 实测：首页那条一直停在 v7.1.5，而 GitHub 侧已经是 v7.2.0。）
    //    补一条只认 tag 形态的规则，让下一轮 prebuild 能把它换成 canonical 直链；
    //    两种形态都写成自身即为幂等（降级时写 tag、API 可用时写 attach_files）。
    re: /https:\/\/gitee\.com\/lzul\/pastepanda\/releases\/tag\/v?\d+\.\d+\.\d+/g,
    repl: () => giteeUrl,
  },
  {
    name: "品牌版本",
    // ❗ 必须容忍 span 上的其它属性：`docs/manual/index.html` 这两处带着
    //    `data-page-node-id`（Pages 编辑器注的），只写 `<span class="ver">` 匹配不到，
    //    于是那页的品牌名与顶栏版本**从 v7.1.4 起就再没被同步过**——2026-09-17 实测：
    //    下载按钮已经是 v7.2.1，页面标题栏还写着 v7.1.4。
    re: /(<span class="ver"[^>]*>)v?\d+\.\d+\.\d+(<\/span>)/g,
    repl: (_, a, b) => `${a}v${version}${b}`,
  },
  {
    name: "顶栏版本",
    re: /(<span class="hw-tver"[^>]*>)v?\d+\.\d+\.\d+(<\/span>)/g,
    repl: (_, a, b) => `${a}v${version}${b}`,
  },
  {
    name: "最新版本文字",
    re: /(最新版本 <b[^>]*>)v?\d+\.\d+\.\d+(<\/b>)/g,
    repl: (_, a, b) => `${a}v${version}${b}`,
  },
  ...(releaseCount
    ? [
        {
          name: "版本迭代计数（hero trust 条）",
          re: /\d+\s*个版本持续迭代/g,
          repl: () => `${releaseCount} 个版本持续迭代`,
        },
      ]
    : []),
];

// 3. 逐个文件应用规则
let total = 0;
for (const file of TARGETS) {
  const p = path.join(MANUAL_DIR, file);
  if (!fs.existsSync(p)) {
    info(`跳过（文件不存在）: ${file}`);
    continue;
  }
  let content = fs.readFileSync(p, "utf-8");
  let fileCount = 0;
  for (const rule of rules) {
    const matches = content.match(rule.re);
    if (matches && matches.length > 0) {
      fileCount += matches.length;
      content = content.replace(rule.re, rule.repl);
    }
  }
  if (fileCount === 0) {
    info(`无当前版本位，跳过: ${file}`);
    continue;
  }
  fs.writeFileSync(p, content, "utf-8");
  total += fileCount;
  info(`已同步 ${file}: ${fileCount} 处 → v${version}`);
}

if (total === 0) {
  fail("未在任何手册文件中匹配到「当前版本」位置，请检查 docs/manual/*.html 结构是否改动（ver / hw-tver / 下载链接 / 最新版本）。");
}
success(`完成，共同步 ${total} 处当前版本号（v${version}）`);
