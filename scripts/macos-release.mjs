#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { generateManifest } from "./updater-manifest.mjs";
import { missingReleaseConfiguration, notarizationArguments } from "./macos-release-options.mjs";
import { createHash } from "node:crypto";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const conf = JSON.parse(fs.readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"));
const mode = process.argv[2] ?? "check";
if (!["check", "build", "verify"].includes(mode)) throw new Error("Usage: macos-release.mjs check|build|verify");
if (process.platform !== "darwin") throw new Error("Mac release requires macOS");
const bundle = path.join(root, "src-tauri/target-macos/universal-apple-darwin/release/bundle");
const app = path.join(bundle, "macos", `${conf.productName}.app`);
function run(command, args, capture = false) {
  const result = spawnSync(command, args, { cwd: root, env: process.env, encoding: "utf8", stdio: capture ? "pipe" : "inherit" });
  if (result.error || result.status !== 0) throw new Error(`${command} failed${capture ? `: ${result.stderr.trim()}` : ""}`);
  return result.stdout;
}
function check() {
  const identities = run("security", ["find-identity", "-v", "-p", "codesigning"], true);
  const missing = missingReleaseConfiguration(process.env, identities, fs.existsSync);
  if (missing.length) throw new Error(`正式发布缺少：\n- ${missing.join("\n- ")}\n请通过钥匙串、环境变量或 GitHub Secrets 配置，不要写入源码。`);
  console.log("发布所需配置已提供；签名、公证及更新签名将在产物阶段验证。");
}
function notarizeDmg() {
  const files = fs.readdirSync(path.join(bundle, "dmg")).filter(f => f.endsWith(".dmg"));
  if (files.length !== 1) throw new Error("需要唯一的 DMG");
  const dmg = path.join(bundle, "dmg", files[0]);
  if (spawnSync("xcrun", ["stapler", "validate", dmg], { stdio: "ignore" }).status === 0) return;
  run("codesign", ["--force", "--sign", process.env.APPLE_SIGNING_IDENTITY, dmg]);
  const reply = run("xcrun", ["notarytool", "submit", dmg, ...notarizationArguments(process.env), "--wait", "--timeout", "30m", "--output-format", "json"], true);
  const receipt = JSON.parse(reply);
  if (receipt.status !== "Accepted") throw new Error(`DMG 公证未通过：${receipt.status}，提交 ID ${receipt.id}`);
  run("xcrun", ["stapler", "staple", dmg]);
}
function digest(file) {
  const hash = createHash("sha256"), buffer = Buffer.allocUnsafe(1024 * 1024);
  const fd = fs.openSync(file, "r");
  try {
    for (let size; (size = fs.readSync(fd, buffer)) > 0;) hash.update(buffer.subarray(0, size));
    return hash.digest("hex");
  } finally { fs.closeSync(fd); }
}
function verifyAppCopy(copy) {
  run("codesign", ["--verify", "--deep", "--strict", copy]);
  run("xcrun", ["stapler", "validate", copy]);
  for (const relative of ["Contents/MacOS/" + conf.productName, "Contents/Info.plist"]) {
    if (digest(path.join(copy, relative)) !== digest(path.join(app, relative))) throw new Error("交付包与已验证应用不一致");
  }
}
function verifyDmgContents(dmg) {
  const mount = fs.mkdtempSync(path.join(root, ".cache/macos-release-mount-"));
  let attached = false;
  try {
    run("hdiutil", ["attach", "-readonly", "-nobrowse", "-mountpoint", mount, dmg]);
    attached = true;
    verifyAppCopy(path.join(mount, `${conf.productName}.app`));
  } finally {
    // Leave the mount directory intact if detach fails; never delete a mounted volume.
    if (attached) run("hdiutil", ["detach", mount]);
    fs.rmSync(mount, { recursive: true });
  }
}
function verifyArchiveContents(archive) {
  const entries = run("tar", ["-tzf", archive], true).trim().split("\n");
  if (entries.some(entry => {
    const normalized = entry.replace(/^\.\//, "");
    return entry.startsWith("/") || entry.split("/").includes("..") ||
      !(normalized === `${conf.productName}.app` || normalized.startsWith(`${conf.productName}.app/`));
  })) throw new Error("更新归档包含异常路径");
  const scratch = fs.mkdtempSync(path.join(root, ".cache/macos-release-verify-"));
  try {
    run("tar", ["-xzf", archive, "-C", scratch]);
    verifyAppCopy(path.join(scratch, `${conf.productName}.app`));
  } finally { fs.rmSync(scratch, { recursive: true }); }
}
async function verifyArtifacts() {
  run("codesign", ["--verify", "--deep", "--strict", app]);
  // codesign writes display information to stderr, unlike verification output.
  const detail = spawnSync("codesign", ["-dv", "--verbose=4", app], { encoding: "utf8" }).stderr;
  if (!detail.includes("Authority=Developer ID Application:") || !detail.includes("runtime") || !/TeamIdentifier=(?!not set)\S+/.test(detail)) {
    throw new Error("应用缺少有效 Developer ID / hardened runtime / TeamIdentifier");
  }
  const arches = run("lipo", ["-archs", path.join(app, "Contents/MacOS", conf.productName)], true).trim().split(/\s+/);
  if (!arches.includes("arm64") || !arches.includes("x86_64")) throw new Error("应用不是完整 Universal 构建");
  const version = run("/usr/libexec/PlistBuddy", ["-c", "Print :CFBundleShortVersionString", path.join(app, "Contents/Info.plist")], true).trim();
  if (version !== conf.version) throw new Error("应用版本与仓库配置不一致");
  run("xcrun", ["stapler", "validate", app]);
  run("spctl", ["--assess", "--type", "execute", "--verbose=2", app]);
  const dmgs = fs.readdirSync(path.join(bundle, "dmg")).filter(f => f.endsWith(".dmg"));
  if (dmgs.length !== 1) throw new Error("需要唯一的已公证 DMG");
  const dmg = path.join(bundle, "dmg", dmgs[0]);
  run("hdiutil", ["verify", dmg]);
  run("codesign", ["--verify", "--strict", dmg]);
  run("xcrun", ["stapler", "validate", dmg]);
  verifyDmgContents(dmg);
  const manifest = await generateManifest({ bundleDir: bundle, version: conf.version,
    tag: `v${conf.version}`, publicKey: conf.plugins.updater.pubkey, platforms: ["mac"], macosArch: "universal",
    notes: process.env.UPDATER_NOTES,
    downloadBase: `https://github.com/${process.env.GITHUB_REPOSITORY || "lzlkyb/pastepanda"}/releases/download` });
  const output = path.join(root, "dist/macos-release"); fs.mkdirSync(output, { recursive: true });
  const entry = manifest.platforms["darwin-aarch64"];
  const archiveName = decodeURIComponent(new URL(entry.url).pathname.split("/").at(-1));
  const archive = path.join(bundle, "macos", archiveName);
  verifyArchiveContents(archive);
  const files = [dmg, archive, `${archive}.sig`];
  const allowed = new Set([...files.map(file => path.basename(file)), "updater-macos.json", "SHA256SUMS", "release-evidence.json"]);
  if (fs.readdirSync(output).some(file => !allowed.has(file))) throw new Error("发布目录有其它版本产物，请使用干净输出目录");
  for (const file of files) fs.copyFileSync(file, path.join(output, path.basename(file)));
  fs.writeFileSync(path.join(output, "updater-macos.json"), JSON.stringify(manifest, null, 2) + "\n");
  fs.writeFileSync(path.join(output, "SHA256SUMS"), files.map(file => `${digest(file)}  ${path.basename(file)}\n`).join(""));
  fs.writeFileSync(path.join(output, "release-evidence.json"), JSON.stringify({ version: conf.version, source: run("git", ["rev-parse", "HEAD"], true).trim(), workingTree: run("git", ["status", "--porcelain", "--untracked-files=normal"], true).trim(), architectures: arches, notarized: true }, null, 2) + "\n");
  console.log(`正式发布产物校验通过：${output}`);
}
try {
  if (mode !== "verify") check();
  if (mode === "build") {
    run(process.execPath, ["scripts/macos-dev.mjs", "build", "--target", "universal-apple-darwin", "--bundles", "app,dmg", "--config", "src-tauri/tauri.macos.release.conf.json"]);
    notarizeDmg();
  }
  if (mode !== "check") await verifyArtifacts();
} catch (error) { console.error(error.message); process.exitCode = 1; }
