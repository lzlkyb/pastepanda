import { createHash, createPublicKey, verify } from "node:crypto";
import { createReadStream, readFileSync, statSync } from "node:fs";

function decode64(text) {
  if (!text || !/^[A-Za-z0-9+/]+={0,2}$/.test(text) || text.length % 4) {
    throw new Error("更新签名不是有效 Base64");
  }
  const bytes = Buffer.from(text, "base64");
  if (bytes.toString("base64") !== text) throw new Error("更新签名编码不规范");
  return bytes;
}

// Matches the prehashed Minisign contract used by Tauri's updater. Both the
// archive signature and the authenticated comment must verify against its key.
export async function verifyUpdaterSignature(archive, signature, publicKey) {
  const keyLines = decode64(publicKey).toString("utf8").trim().split(/\r?\n/);
  const sigLines = decode64(signature).toString("utf8").trim().split(/\r?\n/);
  if (keyLines.length !== 2 || sigLines.length !== 4 ||
      !keyLines[0].startsWith("untrusted comment: ") ||
      !sigLines[0].startsWith("untrusted comment: ") ||
      !sigLines[2].startsWith("trusted comment: ")) {
    throw new Error("更新签名格式无效");
  }
  const key = decode64(keyLines[1]);
  const signed = decode64(sigLines[1]);
  const global = decode64(sigLines[3]);
  if (key.length !== 42 || signed.length !== 74 || global.length !== 64 ||
      key.subarray(0, 2).toString() !== "Ed" ||
      signed.subarray(0, 2).toString() !== "ED") {
    throw new Error("更新产物须使用当前 Tauri signer 的预哈希签名");
  }
  if (!key.subarray(2, 10).equals(signed.subarray(2, 10))) {
    throw new Error("更新签名私钥与应用配置的公钥不匹配");
  }
  const der = Buffer.concat([Buffer.from("302a300506032b6570032100", "hex"), key.subarray(10)]);
  const verifier = createPublicKey({ key: der, format: "der", type: "spki" });
  if (!statSync(archive).isFile()) throw new Error("更新产物不是普通文件");
  const hash = createHash("blake2b512");
  for await (const chunk of createReadStream(archive)) hash.update(chunk);
  if (!verify(null, hash.digest(), verifier, signed.subarray(10))) {
    throw new Error("更新产物签名验证失败");
  }
  const comment = Buffer.from(sigLines[2].slice("trusted comment: ".length));
  if (!verify(null, Buffer.concat([signed.subarray(10), comment]), verifier, global)) {
    throw new Error("更新签名的可信注释验证失败");
  }
}

export function readUpdaterSignature(file) {
  if (statSync(file).size > 4096) throw new Error("更新签名文件过大");
  const signature = readFileSync(file, "utf8").trim();
  if (!signature) throw new Error("缺少更新产物签名");
  return signature;
}
