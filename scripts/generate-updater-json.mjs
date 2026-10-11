#!/usr/bin/env node
/** Generate only verified Tauri updater artifacts. Mac uses .app.tar.gz, not DMG.
 * Env: UPDATER_BUNDLE_DIR, UPDATER_MACOS_ARCH (universal/aarch64/x86_64),
 * UPDATER_PLATFORMS (win,linux,mac), UPDATER_DOWNLOAD_BASE, UPDATER_URL_TEMPLATE,
 * UPDATER_OUTPUT_FILENAME, UPDATER_NOTES and GITHUB_RELEASE_TAG.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { generateManifest } from "./updater-manifest.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const config = JSON.parse(fs.readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"));
const args = process.argv.slice(2);
let selected = process.env.UPDATER_PLATFORMS;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--platforms" && args[i + 1]) selected = args[++i];
  else if (args[i].startsWith("--platforms=")) selected = args[i].slice(12);
  else if (args[i] !== config.version) throw new Error(`未知参数或版本不匹配: ${args[i]}`);
}
const repository = process.env.GITHUB_REPOSITORY || "lzlkyb/pastepanda";
if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository)) throw new Error("仓库名无效");
const filename = process.env.UPDATER_OUTPUT_FILENAME || "updater.json";
if (path.basename(filename) !== filename || !filename.endsWith(".json")) throw new Error("更新清单文件名无效");
try {
  const manifest = await generateManifest({
    bundleDir: process.env.UPDATER_BUNDLE_DIR || path.join(root, "src-tauri/target/release/bundle"),
    version: config.version,
    tag: process.env.GITHUB_RELEASE_TAG || `v${config.version}`,
    publicKey: config.plugins.updater.pubkey,
    platforms: selected ? selected.split(",").map(p => p.trim()) : undefined,
    macosArch: process.env.UPDATER_MACOS_ARCH,
    notes: process.env.UPDATER_NOTES,
    downloadBase: process.env.UPDATER_DOWNLOAD_BASE || `https://github.com/${repository}/releases/download`,
    urlTemplate: process.env.UPDATER_URL_TEMPLATE,
  });
  fs.mkdirSync(path.join(root, "dist"), { recursive: true });
  const output = path.join(root, "dist", filename);
  fs.writeFileSync(output, JSON.stringify(manifest, null, 2) + "\n");
  console.log(`已验证签名并生成更新清单: ${output}`);
  console.log(`平台: ${Object.keys(manifest.platforms).join(", ")}`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
