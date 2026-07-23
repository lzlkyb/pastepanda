#!/usr/bin/env node
/**
 * generate-updater-json.mjs
 * 构建后自动生成 updater.json 用于 Tauri v2 自动更新。
 *
 * 用法：
 *   node scripts/generate-updater-json.mjs [version] [--platforms win,linux,mac]
 *
 * 环境变量：
 *   UPDATER_NOTES            - 更新日志 (可选)
 *   GITHUB_RELEASE_TAG       - GitHub Release tag (可选，默认 v{version})
 *   UPDATER_DOWNLOAD_BASE    - 二进制下载基线 URL（默认 GitHub Release；CI 可设为 ghproxy 镜像）
 *   UPDATER_URL_TEMPLATE     - 完全接管 URL 拼接（支持 {tag}/{filename} 占位符，优先级高于 UPDATER_DOWNLOAD_BASE）
 *   UPDATER_OUTPUT_FILENAME  - 输出文件名（默认 updater.json；Gitee 变体设为 updater-gitee.json）
 *
 * 输出：dist/{UPDATER_OUTPUT_FILENAME}
 *
 * 流程：
 *   1. 读取 src-tauri/target/release/bundle/{nsis,msi,appimage,macos}/ 下的 .sig 文件
 *   2. 拼接下载 URL（GitHub / ghproxy / Gitee 模板）
 *   3. 生成符合 Tauri v2 格式的 updater manifest
 */

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..");
const BUNDLE_DIR = path.join(ROOT, "src-tauri", "target", "release", "bundle");

// ─── 配置 ────────────────────────────────────────────────

const [FALLBACK_OWNER, FALLBACK_REPO] = ["lzlkyb", "pastepanda"];
const [REPO_OWNER, REPO_NAME] = (
  process.env.GITHUB_REPOSITORY || `${FALLBACK_OWNER}/${FALLBACK_REPO}`
).split("/");

// 二进制下载基线 URL：默认 GitHub Release；CI/生产可经 UPDATER_DOWNLOAD_BASE 指向 ghproxy 镜像
const GITHUB_RELEASE_BASE =
  process.env.UPDATER_DOWNLOAD_BASE ||
  `https://github.com/${REPO_OWNER}/${REPO_NAME}/releases/download`;

// URL 模板（Gitee 场景）：完全接管 URL 拼接，支持 {tag}/{filename} 占位符，
// 优先级高于 UPDATER_DOWNLOAD_BASE（两者互斥）
const URL_TEMPLATE = process.env.UPDATER_URL_TEMPLATE || null;

// 输出文件名：Gitee 变体与 GitHub 变体输出为不同文件，同一脚本跑两次即可
const OUTPUT_FILENAME = process.env.UPDATER_OUTPUT_FILENAME || "updater.json";

// ─── 平台映射 ────────────────────────────────────────────

const PLATFORM_CONFIGS = [
  {
    name: "windows-nsis",
    dir: "nsis",
    filePattern: /\.exe$/,
    ext: ".exe",
    platformKey: "windows-x86_64",
  },
  {
    name: "windows-msi",
    dir: "msi",
    filePattern: /\.msi$/,
    ext: ".msi",
    platformKey: "windows-x86_64",
  },
  {
    name: "linux-appimage",
    dir: "appimage",
    filePattern: /\.AppImage$/,
    ext: ".AppImage",
    platformKey: "linux-x86_64",
  },
  {
    name: "macos-dmg",
    dir: "dmg",
    filePattern: /\.dmg$/,
    ext: ".dmg",
    platformKey: "darwin-x86_64",
  },
];

// ─── 辅助函数 ────────────────────────────────────────────

function fail(msg) {
  console.error(`\x1b[31m[ERROR]\x1b[0m ${msg}`);
  process.exit(1);
}

function warn(msg) {
  console.warn(`\x1b[33m[WARN]\x1b[0m ${msg}`);
}

function info(msg) {
  console.log(`\x1b[36m[INFO]\x1b[0m ${msg}`);
}

function success(msg) {
  console.log(`\x1b[32m[OK]\x1b[0m ${msg}`);
}

/** 查找 bundle 目录下的安装包和签名文件 */
function findArtifacts(config) {
  const dirPath = path.join(BUNDLE_DIR, config.dir);
  if (!fs.existsSync(dirPath)) return null;

  const files = fs.readdirSync(dirPath);

  const pkgFile = files.find(
    (f) => config.filePattern.test(f) && !f.endsWith(".sig")
  );
  if (!pkgFile) return null;

  const sigFile = files.find(
    (f) =>
      f === `${pkgFile}.sig` ||
      f === `${path.basename(pkgFile, config.ext)}${config.ext}.sig`
  );

  if (!sigFile) {
    warn(`${config.name}: 找到 ${pkgFile} 但没有 .sig 签名文件 → updater 将无法验证签名`);
    return { fileName: pkgFile, signature: "" };
  }

  const sigPath = path.join(dirPath, sigFile);
  const signature = fs.readFileSync(sigPath, "utf-8").trim();
  if (!signature) {
    warn(`${config.name}: 签名文件为空 → updater 将无法验证签名`);
    return { fileName: pkgFile, signature: "" };
  }

  return { fileName: pkgFile, signature };
}

/** 根据配置生成下载 URL */
function buildDownloadUrl(tag, filename) {
  if (URL_TEMPLATE) {
    return URL_TEMPLATE.replaceAll("{tag}", tag).replaceAll("{filename}", filename);
  }
  return `${GITHUB_RELEASE_BASE}/${tag}/${filename}`;
}

// ─── 主逻辑 ──────────────────────────────────────────────

function readVersionFromConf() {
  const confPath = path.join(ROOT, "src-tauri", "tauri.conf.json");
  if (!fs.existsSync(confPath)) {
    fail(`找不到 tauri.conf.json: ${confPath}`);
  }
  const conf = JSON.parse(fs.readFileSync(confPath, "utf-8"));
  const version = conf.version;
  if (!version) {
    fail("tauri.conf.json 中未找到 version 字段");
  }
  return version;
}

function main() {
  const cleanVersion = readVersionFromConf();
  const tag = process.env.GITHUB_RELEASE_TAG || `v${cleanVersion}`;
  const notes = process.env.UPDATER_NOTES || "";

  info(`仓库: ${REPO_OWNER}/${REPO_NAME}`);
  info(`版本: ${cleanVersion}`);
  info(`Release Tag: ${tag}`);
  info(`输出文件: ${OUTPUT_FILENAME}`);
  if (URL_TEMPLATE) {
    info(`URL 模板: ${URL_TEMPLATE}`);
  } else {
    info(`下载基线: ${GITHUB_RELEASE_BASE}`);
  }
  info(`扫描构建产物: ${BUNDLE_DIR}`);

  const platforms = {};

  for (const cfg of PLATFORM_CONFIGS) {
    const result = findArtifacts(cfg);
    if (!result) continue;

    const downloadUrl = buildDownloadUrl(tag, result.fileName);

    platforms[cfg.platformKey] = {
      signature: result.signature,
      url: downloadUrl,
    };

    success(`${cfg.name}: ${result.fileName}`);
    info(`  下载 URL: ${downloadUrl}`);
  }

  if (Object.keys(platforms).length === 0) {
    fail(
      "未找到任何构建产物和签名文件。\n" +
        "请先运行 npx tauri build 构建应用。\n" +
        "确保 tauri.conf.json 中 bundle.createUpdaterArtifacts = true"
    );
  }

  const updaterJson = {
    version: cleanVersion,
    notes: notes || `PastePanda v${cleanVersion}`,
    pub_date: new Date().toISOString(),
    platforms,
  };

  const distDir = path.join(ROOT, "dist");
  if (!fs.existsSync(distDir)) {
    fs.mkdirSync(distDir, { recursive: true });
  }

  const outputPath = path.join(distDir, OUTPUT_FILENAME);
  fs.writeFileSync(outputPath, JSON.stringify(updaterJson, null, 2), "utf-8");

  success(`已生成: ${outputPath}`);
  console.log(`\n--- ${OUTPUT_FILENAME} 内容预览 ---`);
  console.log(JSON.stringify(updaterJson, null, 2));
  console.log("--- 预览结束 ---\n");
}

main();
