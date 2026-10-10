#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cache = path.join(root, ".cache"); mkdirSync(cache, { recursive: true });
const temp = mkdtempSync(path.join(cache, "av1-fixtures-"));
function run(command, args, capture = false) {
  const result = spawnSync(command, args, { cwd: root, encoding: "utf8", stdio: capture ? "pipe" : "inherit", timeout: 60000 });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message ?? result.stderr ?? result.status}`);
  return result.stdout;
}
try {
  const library = path.join(root, ".cache/macos-av1-runtime/libpastepanda_av1.dylib");
  if (!existsSync(library)) throw new Error("Build the AV1 runtime before running the fixture check.");
  const binary = path.join(temp, "av1-probe");
  run("xcrun", ["clang", "-O2", "-mmacosx-version-min=12.0", "src-tauri/src/macos/tests/av1_probe.c", "-o", binary]);
  for (const width of [64, 1280, 1920]) {
    const stream = path.join(temp, `${width}.ivf`);
    run(binary, [library, stream, String(width)]);
    const decoder = process.env.PASTEPANDA_AV1_DECODER;
    if (decoder) {
      const decoded = run(decoder, ["-hide_banner", "-v", "error", "-c:v", "libaom-av1", "-i", stream, "-f", "framemd5", "-"], true);
      const frames = decoded.split("\n").filter(line => /^\s*0,/.test(line));
      if (frames.length < 20 || new Set(frames.map(line => line.split(",").at(-1)?.trim())).size < 10) throw new Error("Independent AV1 decoder did not produce enough changing frames");
      console.log(`PASS: independent libaom software decoder read ${frames.length} changing frames at width ${width}`);
      const recovered = run(decoder, ["-hide_banner", "-v", "error", "-c:v", "libaom-av1", "-i", `${stream}.recovery.ivf`, "-f", "framemd5", "-"], true);
      const recoveryFrames = recovered.split("\n").filter(line => /^\s*0,/.test(line));
      if (recoveryFrames.length < 8) throw new Error("Fresh AV1 decoder failed to recover from the forced keyframe");
      console.log(`PASS: fresh decoder recovered ${recoveryFrames.length} frames from the forced keyframe without prior state`);
    }
  }
  if (!process.env.PASTEPANDA_AV1_DECODER) console.log("Independent frame decode was not requested; encoding/forced-key checks passed only.");
} finally { rmSync(temp, { recursive: true, force: true }); }
