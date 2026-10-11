#!/usr/bin/env node
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { readUpdaterSignature, verifyUpdaterSignature } from "./updater-signature.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
export async function checkUpdaterKey(publicKey, privateKey, password = "") {
  if (!privateKey?.trim()) throw new Error("Missing TAURI_SIGNING_PRIVATE_KEY");
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), "pastepanda-updater-key-"));
  try {
    const file = path.join(scratch, "compatibility-fixture.txt");
    fs.writeFileSync(file, "PastePanda updater signing key compatibility fixture\n");
    const env = { ...process.env, TAURI_SIGNING_PRIVATE_KEY: privateKey };
    delete env.TAURI_SIGNING_PRIVATE_KEY_PATH;
    const result = spawnSync(process.execPath,
      [path.join(root, "node_modules/@tauri-apps/cli/tauri.js"), "signer", "sign", "--password", password, file],
      { env,
        encoding: "utf8", stdio: "pipe", input: "", timeout: 30000 });
    // Do not print signer output or arguments: authentication failures can
    // include user-provided key material. Only the verified result is reported.
    if (result.error || result.status !== 0) throw new Error("Tauri 签名失败，请检查更新私钥及密码配置");
    await verifyUpdaterSignature(file, readUpdaterSignature(`${file}.sig`), publicKey);
  } finally { fs.rmSync(scratch, { recursive: true }); }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  try {
    const conf = JSON.parse(fs.readFileSync(path.join(root, "src-tauri/tauri.conf.json"), "utf8"));
    await checkUpdaterKey(conf.plugins.updater.pubkey, process.env.TAURI_SIGNING_PRIVATE_KEY, process.env.TAURI_SIGNING_PRIVATE_KEY_PASSWORD);
    console.log("现有更新私钥与应用公钥匹配；临时签名文件已清理。");
  } catch (error) { console.error(error.message); process.exitCode = 1; }
}
