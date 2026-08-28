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
    const asset = Array.isArray(files) ? files.find((a) => a.name === `PastePanda_v${version}_x64-setup.exe`) : null;
    if (asset && asset.id) {
      giteeUrl = `https://gitee.com/lzul/pastepanda/attach_files/${asset.id}/download/PastePanda_v${version}_x64-setup.exe`;
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
const rules = [
  {
    name: "GitHub 下载链接",
    re: /https:\/\/github\.com\/lzlkyb\/pastepanda\/releases\/download\/v?\d+\.\d+\.\d+\/PastePanda_v?\d+\.\d+\.\d+_x64-setup\.exe/g,
    repl: () => `https://github.com/lzlkyb/pastepanda/releases/download/v${version}/PastePanda_v${version}_x64-setup.exe`,
  },
  {
    name: "Gitee 下载链接（canonical attach_files，浏览器可用）",
    // 同时匹配旧 releases/download 形态与新 attach_files 形态，便于跨版本同步。
    // API 成功 → 写入 canonical 直链；API 失败 → 若文件已是 canonical 则保留，否则回退 tag 页。
    re: /https:\/\/gitee\.com\/lzul\/pastepanda\/(?:releases\/download\/v?\d+\.\d+\.\d+|attach_files\/\d+\/download)\/PastePanda_v?\d+\.\d+\.\d+_x64-setup\.exe/g,
    repl: (m) => (giteeOk ? giteeUrl : (m.includes("/attach_files/") ? m : giteeUrl)),
  },
  {
    name: "品牌版本",
    re: /(<span class="ver">)v?\d+\.\d+\.\d+(<\/span>)/g,
    repl: (_, a, b) => `${a}v${version}${b}`,
  },
  {
    name: "顶栏版本",
    re: /(<span class="hw-tver">)v?\d+\.\d+\.\d+(<\/span>)/g,
    repl: (_, a, b) => `${a}v${version}${b}`,
  },
  {
    name: "最新版本文字",
    re: /(最新版本 <b[^>]*>)v?\d+\.\d+\.\d+(<\/b>)/g,
    repl: (_, a, b) => `${a}v${version}${b}`,
  },
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
