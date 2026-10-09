#!/usr/bin/env node
// Pure/native fixture probes; these do not record the desktop or inject input.
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
if (process.platform !== "darwin") {
  console.error("Native probes require macOS and Xcode command-line tools.");
  process.exit(1);
}
const cache = path.join(root, ".cache");
mkdirSync(cache, { recursive: true });
const output = mkdtempSync(path.join(cache, "native-probes-"));
const native = "src-tauri/src/macos";
const probes = [
  ["recording_audio", ["recording_audio.m"]],
  ["recording_frame", ["recording_frame.m"]],
  ["recording_timing", ["recording_audio.m", "recording_overlay.m", "recording_frame.m"]],
  ["recording_overlay", ["recording_overlay.m"]],
  ["remote_capture", ["remote_video.m", "recording_frame.m"]],
  ["remote_input", []],
  ["remote_input_lock", []],
  ["remote_jpeg", ["remote_jpeg.m"]],
  ["remote_video", ["recording_frame.m"]],
  ["remote_audio", ["remote_audio_encoder.m"]],
  ["speaker", []],
  ["keep_awake", []],
  ["screenshot_legacy", []],
  ["screen_metadata", []],
];
const frameworks = ["AppKit", "AVFoundation", "CoreMedia", "CoreVideo", "ImageIO", "ApplicationServices", "ScreenCaptureKit", "VideoToolbox"];
function run(command, args, timeout) {
  const result = spawnSync(command, args, { cwd: root, stdio: "inherit", timeout });
  if (result.error || result.status !== 0) {
    throw new Error(`${command} failed: ${result.error?.message ?? result.status}`);
  }
}
try {
  for (const [name, sources] of probes) {
    console.log(`\nChecking ${name} (fixtures only)`);
    const binary = path.join(output, name);
    run("xcrun", ["clang", "-fobjc-arc", "-fblocks", "-mmacosx-version-min=12.0",
      `${native}/tests/${name}_probe.m`, ...sources.map(source => `${native}/${source}`),
      ...frameworks.flatMap(framework => ["-framework", framework]), "-o", binary], 60000);
    run(binary, name === "remote_video" ? [path.join(cache, "macos-vt-packets.json")] : name === "remote_audio" ? [path.join(cache, "macos-aac-packets.json")] : [], 15000);
  }
  console.log("\nAll fourteen native fixture probes passed. Desktop capture, permissions and audio hearing still need actual application validation.");
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
} finally {
  rmSync(output, { recursive: true, force: true });
}
