// @vitest-environment node
import { beforeAll, expect, it } from "vitest";
import * as openpgp from "openpgp";
import { verifySignedArchive } from "./macos-av1-source-signature.mjs";
let publicKey: string, signature: string, fingerprint: string;
const data = new Uint8Array([1, 2, 3, 4]);
beforeAll(async () => {
  const keys = await openpgp.generateKey({ type: "rsa", rsaBits: 2048, userIDs: [{ name: "Temporary source verification fixture" }] });
  publicKey = keys.publicKey;
  const key = await openpgp.readPrivateKey({ armoredKey: keys.privateKey });
  fingerprint = key.getFingerprint();
  signature = await openpgp.sign({ message: await openpgp.createMessage({ binary: data }), signingKeys: key, detached: true }) as string;
});
it("accepts the pinned release key and original source", async () => {
  await expect(verifySignedArchive(data, publicKey, signature, fingerprint)).resolves.toBeUndefined();
});
it("rejects modified source bytes", async () => {
  await expect(verifySignedArchive(new Uint8Array([1, 2, 3, 5]), publicKey, signature, fingerprint)).rejects.toThrow();
});
it("rejects a key outside the pinned fingerprint", async () => {
  await expect(verifySignedArchive(data, publicKey, signature, "0".repeat(40))).rejects.toThrow("fingerprint");
});
