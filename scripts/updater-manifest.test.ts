import { afterEach, expect, it } from "vitest";
import { createHash, generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { generateManifest, macPlatformKeys } from "./updater-manifest.mjs";

const dirs: string[] = [];
afterEach(() => { for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true }); });
function fixture(folder = "macos", name = "PastePanda.app.tar.gz") {
  const dir = mkdtempSync(path.join(tmpdir(), "pp-manifest-")); dirs.push(dir);
  mkdirSync(path.join(dir, folder));
  const file = path.join(dir, folder, name);
  const bytes = Buffer.from("synthetic archive fixture, no user files");
  writeFileSync(file, bytes);
  const pair = generateKeyPairSync("ed25519"), id = randomBytes(8);
  const key = pair.publicKey.export({ type: "spki", format: "der" }).subarray(-32);
  const publicKey = Buffer.from(`untrusted comment: fixture\n${Buffer.concat([Buffer.from("Ed"), id, key]).toString("base64")}\n`).toString("base64");
  const sig = sign(null, createHash("blake2b512").update(bytes).digest(), pair.privateKey);
  const comment = "fixture timestamp:0";
  const global = sign(null, Buffer.concat([sig, Buffer.from(comment)]), pair.privateKey);
  const text = `untrusted comment: fixture\n${Buffer.concat([Buffer.from("ED"), id, sig]).toString("base64")}\ntrusted comment: ${comment}\n${global.toString("base64")}\n`;
  const signature = Buffer.from(text).toString("base64"); writeFileSync(`${file}.sig`, signature);
  return { dir, file, signature, publicKey, opts: { bundleDir: dir, version: "7.2.10", tag: "v7.2.10", publicKey, platforms: ["mac"], macosArch: "universal" } };
}

it("Universal updates point both architectures at the signed app archive", async () => {
  const f = fixture(); const result = await generateManifest(f.opts);
  expect(Object.keys(result.platforms)).toEqual(["darwin-aarch64", "darwin-x86_64"]);
  expect(result.platforms["darwin-aarch64"]).toEqual(result.platforms["darwin-x86_64"]);
  expect(result.platforms["darwin-aarch64"].url).toMatch(/\.app\.tar\.gz$/);
});
it("DMG is never accepted as a Tauri macOS updater artifact", async () => {
  const f = fixture("dmg", "PastePanda.dmg");
  await expect(generateManifest(f.opts)).rejects.toThrow(/没有已签名/);
});
it("rejects modified archives even with a well formed signature", async () => {
  const f = fixture(); writeFileSync(f.file, "tampered");
  await expect(generateManifest(f.opts)).rejects.toThrow(/签名验证失败/);
});
it("rejects signatures from another configured key", async () => {
  const f = fixture(), other = fixture();
  await expect(generateManifest({ ...f.opts, publicKey: other.publicKey })).rejects.toThrow(/公钥不匹配/);
});
it("authenticates the trusted comment as well as the archive", async () => {
  const f = fixture();
  writeFileSync(`${f.file}.sig`, Buffer.from(Buffer.from(f.signature, "base64").toString().replace("timestamp:0", "timestamp:1")).toString("base64"));
  await expect(generateManifest(f.opts)).rejects.toThrow(/可信注释/);
});
it("requires a declared Mac architecture and matching release version", async () => {
  expect(() => macPlatformKeys(undefined)).toThrow(/ARCH/);
  expect(macPlatformKeys("aarch64")).toEqual(["darwin-aarch64"]);
  const f = fixture(); await expect(generateManifest({ ...f.opts, tag: "v7.3.0" })).rejects.toThrow(/版本一致/);
});
it("preserves Windows NSIS support and HTTPS mirror URL templates", async () => {
  const f = fixture("nsis", "PastePanda_7.2.10_x64-setup.exe");
  const result = await generateManifest({ ...f.opts, platforms: ["win"], urlTemplate: "https://example.com/{tag}/{filename}" });
  expect(result.platforms["windows-x86_64"].url).toBe("https://example.com/v7.2.10/PastePanda_7.2.10_x64-setup.exe");
  await expect(generateManifest({ ...f.opts, platforms: ["win"], downloadBase: "http://example.com" })).rejects.toThrow(/HTTPS/);
});
