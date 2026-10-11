import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const scratch = mkdtempSync(path.join(os.tmpdir(), "pastepanda-keychain-fixture-"));
try {
  const source = readFileSync(path.join(root, "src-tauri/src/macos/paste.m"), "utf8");
  const start = source.indexOf("int32_t pp_mac_keychain_read(");
  const end = source.indexOf("int32_t pp_mac_write_clipboard(", start);
  if (start < 0 || end < start) throw new Error("Missing Keychain source boundaries");
  writeFileSync(path.join(scratch, "keychain_functions.inc"), source.slice(start, end));
  const executable = path.join(scratch, "keychain-fixture");
  for (const [command, args] of [
    ["xcrun", ["clang", "-fobjc-arc", "-Wno-deprecated-declarations", "-I", scratch,
      path.join(root, "src-tauri/src/macos/tests/keychain_consent_probe.m"),
      "-framework", "Foundation", "-framework", "Security", "-framework", "LocalAuthentication", "-o", executable]],
    [executable, []],
  ]) {
    const result = spawnSync(command, args, { stdio: "inherit", timeout: 30000 });
    if (result.error || result.status !== 0) throw new Error(`${command}: ${result.error?.message ?? result.status}`);
  }
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
