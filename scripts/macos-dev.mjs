#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const mode = process.argv[2] ?? "check";
if (!["check", "dev", "build"].includes(mode)) {
  console.error("Usage: node scripts/macos-dev.mjs check|dev|build");
  process.exit(2);
}
if (process.platform !== "darwin") {
  console.error("This entry point requires macOS.");
  process.exit(1);
}
const localTools = path.join(root, ".cache", "macos-toolchain");
const env = { ...process.env };
const localNode = path.join(localTools, "node");
if (existsSync(path.join(localNode, "npm"))) {
  env.PATH = `${localNode}${path.delimiter}${path.dirname(process.execPath)}${path.delimiter}${env.PATH ?? ""}`;
}
if (existsSync(path.join(localTools, "cargo", "bin", "cargo"))) {
  env.CARGO_HOME = path.join(localTools, "cargo");
  env.RUSTUP_HOME = path.join(localTools, "rustup");
  env.PATH = `${path.join(env.CARGO_HOME, "bin")}${path.delimiter}${env.PATH ?? ""}`;
}
env.CARGO_TARGET_DIR = path.join(root, "src-tauri", "target-macos");
const run = (command, args, capture = false) => spawnSync(command, args, {
  cwd: root, env, stdio: capture ? "pipe" : "inherit", encoding: "utf8",
});
for (const [command, args] of [["xcrun", ["clang", "--version"]], ["cargo", ["--version"]]]) {
  const result = run(command, args, true);
  if (result.error || result.status !== 0) {
    console.error(result.error?.message ?? result.stderr);
    if (command === "xcrun") console.error("Open Xcode and complete its first-run setup and license review yourself.");
    else console.error("Install Rust using rustup before compiling the Mac client.");
    process.exit(1);
  }
  console.log(result.stdout.trim());
}
if (!existsSync(path.join(root, "node_modules", ".bin", "tauri"))) {
  console.error("Install frontend dependencies with npm ci first.");
  process.exit(1);
}
if (!env.LIBCLANG_PATH) {
  const developer = run("xcode-select", ["-p"], true);
  if (developer.status === 0) {
    const lib = path.join(developer.stdout.trim(), "Toolchains", "XcodeDefault.xctoolchain", "usr", "lib");
    if (existsSync(path.join(lib, "libclang.dylib"))) env.LIBCLANG_PATH = lib;
  }
}
if (!env.LIBCLANG_PATH) {
  console.error("Set LIBCLANG_PATH to the directory containing libclang.dylib for the OCR build.");
  process.exit(1);
}
console.log(`LIBCLANG_PATH=${env.LIBCLANG_PATH}`);
if (mode === "check") process.exit(0);
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const prepare = run(npm, ["run", "prebuild"]);
if (prepare.error || prepare.status !== 0) process.exit(prepare.status ?? 1);
// Tauri automatically merges tauri.macos.conf.json on macOS.
const result = run(path.join(root, "node_modules", ".bin", "tauri"), [mode, ...process.argv.slice(3)]);
if (result.error) console.error(result.error.message);
if (result.error || result.status !== 0) process.exit(result.status ?? 1);
// A linker-signed binary is not a sealed app bundle. Repair only local debug
// bundles without a developer identity; release signing stays with the bundler.
if (mode === "build" && process.argv.includes("--debug") && !env.APPLE_SIGNING_IDENTITY) {
  const config = JSON.parse(readFileSync(path.join(root, "src-tauri", "tauri.conf.json"), "utf8"));
  const args = process.argv.slice(3);
  const targetFlag = args.indexOf("--target");
  const target = targetFlag >= 0 ? args[targetFlag + 1] : args.find(arg => arg.startsWith("--target="))?.slice(9);
  const app = path.join(env.CARGO_TARGET_DIR, ...(target ? [target] : []), "debug", "bundle", "macos", `${config.productName}.app`);
  if (existsSync(app)) {
    let signature = run("codesign", ["--verify", "--deep", "--strict", app], true);
    if (signature.status !== 0) {
      const sign = run("codesign", ["--force", "--deep", "--sign", "-", app]);
      if (sign.error || sign.status !== 0) process.exit(sign.status ?? 1);
      signature = run("codesign", ["--verify", "--deep", "--strict", app], true);
    }
    if (signature.error || signature.status !== 0) {
      console.error(signature.error?.message ?? signature.stderr);
      process.exit(signature.status ?? 1);
    }
    console.log("Mac debug app signature verified.");
  }
}
process.exit(0);
