import * as openpgp from "openpgp";
export async function verifySignedArchive(data, armoredKey, armoredSignature, expectedFingerprint) {
  const key = await openpgp.readKey({ armoredKey });
  if (key.getFingerprint().toUpperCase() !== expectedFingerprint.toUpperCase()) throw new Error("Source release key fingerprint mismatch");
  const signature = await openpgp.readSignature({ armoredSignature });
  const result = await openpgp.verify({ message: await openpgp.createMessage({ binary: data }), signature, verificationKeys: key });
  if (result.signatures.length !== 1) throw new Error("Expected one detached source release signature");
  await result.signatures[0].verified;
}
