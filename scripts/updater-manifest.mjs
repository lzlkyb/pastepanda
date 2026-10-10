import fs from "node:fs";
import path from "node:path";
import { readUpdaterSignature, verifyUpdaterSignature } from "./updater-signature.mjs";

export function macPlatformKeys(arch) {
  if (arch === "universal") return ["darwin-aarch64", "darwin-x86_64"];
  if (arch === "aarch64" || arch === "x86_64") return [`darwin-${arch}`];
  throw new Error("Mac 更新需要明确 UPDATER_MACOS_ARCH=universal/aarch64/x86_64");
}

export async function generateManifest({ bundleDir, version, tag, publicKey,
  platforms = ["win", "linux", "mac"], macosArch, notes = "",
  downloadBase = "https://github.com/lzlkyb/pastepanda/releases/download",
  urlTemplate, date = new Date().toISOString() }) {
  if (!/^\d+\.\d+\.\d+(?:-[A-Za-z0-9.-]+)?$/.test(version) || tag !== `v${version}`) {
    throw new Error("发行标签必须与应用版本一致");
  }
  if (!platforms.length || platforms.some(p => !["win", "linux", "mac"].includes(p))) {
    throw new Error("platforms 只接受 win,linux,mac");
  }
  const definitions = [
    ["win", "nsis", /\.exe$/, ["windows-x86_64"]],
    ["win", "msi", /\.msi$/, ["windows-x86_64"]],
    ["linux", "appimage", /\.AppImage$/, ["linux-x86_64"]],
    ["mac", "macos", /\.app\.tar\.gz$/, null],
  ];
  const output = {};
  for (const [platform, folder, pattern, staticKeys] of definitions) {
    if (!platforms.includes(platform)) continue;
    const directory = path.join(bundleDir, folder);
    if (!fs.existsSync(directory)) continue;
    const files = fs.readdirSync(directory).filter(f => pattern.test(f)).sort();
    if (!files.length) continue;
    if (files.length !== 1) throw new Error(`${folder} 有多个更新产物，请使用干净构建目录`);
    const keys = staticKeys ?? macPlatformKeys(macosArch);
    // Keep NSIS as the Windows choice when both installers were built.
    if (keys.every(key => output[key])) continue;
    const file = path.join(directory, files[0]);
    const signature = readUpdaterSignature(`${file}.sig`);
    await verifyUpdaterSignature(file, signature, publicKey);
    const filename = encodeURIComponent(files[0]);
    const url = urlTemplate
      ? urlTemplate.replaceAll("{tag}", tag).replaceAll("{filename}", filename)
      : `${downloadBase.replace(/\/$/, "")}/${tag}/${filename}`;
    if (new URL(url).protocol !== "https:") throw new Error("正式更新下载地址必须为 HTTPS");
    for (const key of keys) output[key] = { signature, url };
  }
  for (const platform of platforms) {
    // With the default all-platform scan, absent build directories are allowed.
    if (platforms.length === 1 && !Object.keys(output).some(k => k.startsWith({win:"windows-",linux:"linux-",mac:"darwin-"}[platform]))) {
      throw new Error(`${platform} 没有已签名的更新产物`);
    }
  }
  if (!Object.keys(output).length) throw new Error("没有已签名的更新产物；Mac 需要 .app.tar.gz，不能使用 DMG");
  return { version, notes: notes || `PastePanda v${version}`, pub_date: date, platforms: output };
}
