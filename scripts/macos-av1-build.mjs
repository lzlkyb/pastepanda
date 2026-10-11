#!/usr/bin/env node
// Build a replaceable LGPL FFmpeg/SVT library; generated binaries stay in cache.
import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { verifySignedArchive } from "./macos-av1-source-signature.mjs";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const cache = path.join(root, ".cache/macos-av1-build");
const runtime = path.join(root, ".cache/macos-av1-runtime");
const args = process.argv.slice(2);
const arch = args[args.indexOf("--arch") + 1] ?? "universal";
if (process.platform !== "darwin" || !["arm64", "x86_64", "universal"].includes(arch)) {
  throw new Error("Usage on macOS: node scripts/macos-av1-build.mjs --arch arm64|x86_64|universal");
}
mkdirSync(cache, { recursive: true }); mkdirSync(runtime, { recursive: true });
const env = { ...process.env, PATH: `${path.dirname(process.execPath)}:${process.env.PATH ?? ""}` };
// Public dependency build tools do not need signing or repository credentials.
for (const name of Object.keys(env)) if (/^(APPLE_|TAURI_SIGNING_|GITHUB_TOKEN$|GH_TOKEN$)/.test(name)) delete env[name];
function run(command, params, cwd = root, capture = false) {
  const result = spawnSync(command, params, { cwd, env, stdio: capture ? "pipe" : "inherit", encoding: "utf8" });
  if (result.error || result.status !== 0) throw new Error(`${command} failed: ${result.error?.message ?? result.stderr ?? result.status}`);
  return result.stdout?.trim();
}
const cmake = process.env.CMAKE ?? (existsSync(path.join(cache, "python-tools/cmake/data/bin/cmake")) ? path.join(cache, "python-tools/cmake/data/bin/cmake") : "cmake");
run(cmake, ["--version"], root, true);
const sources = JSON.parse(readFileSync(path.join(root, "scripts/macos-av1-sources.json"), "utf8"));
async function source(spec) {
  const archive = path.join(cache, spec.file);
  const valid = () => existsSync(archive) && createHash("sha256").update(readFileSync(archive)).digest("hex") === spec.sha256;
  if (!valid()) {
    // Each retry starts at the bytes actually retained, instead of curl's
    // automatic retry truncating a nearly complete large source download.
    let complete = false;
    for (let attempt = 0; attempt < 6 && !complete; attempt++) {
      const result = spawnSync("curl", ["--fail", "--location", "--continue-at", "-", "--connect-timeout", "20", "--max-time", "300", spec.url, "--output", `${archive}.download`], { env, stdio: "inherit" });
      if (result.error) throw result.error;
      complete = result.status === 0;
      if (!complete && ![18, 28, 35, 52, 56].includes(result.status)) throw new Error(`Source download failed (${result.status})`);
      if (!complete) console.log(`Resuming ${spec.file}, attempt ${attempt + 2}`);
    }
    if (!complete) throw new Error(`Source download incomplete: ${spec.file}`);
    const hash = createHash("sha256").update(readFileSync(`${archive}.download`)).digest("hex");
    if (hash !== spec.sha256) throw new Error(`Source checksum mismatch: ${spec.file}`);
    copyFileSync(`${archive}.download`, archive);
  }
  if (spec.signatureFile) {
    await verifySignedArchive(readFileSync(archive), readFileSync(path.join(root, "scripts/macos-av1", spec.keyFile), "utf8"), readFileSync(path.join(root, "scripts/macos-av1", spec.signatureFile), "utf8"), spec.keyFingerprint);
  }
  const directory = path.join(cache, spec.directory);
  if (!existsSync(directory)) run("tar", ["-xf", archive, "-C", cache]);
  return directory;
}
const svt = await source(sources.svt); const ffmpeg = await source(sources.ffmpeg);
const targets = arch === "universal" ? ["arm64", "x86_64"] : [arch];
const libraries = [];
for (const target of targets) {
  console.log(`Building FFmpeg/SVT-AV1 for ${target}, deployment target 12.0`);
  const prefix = path.join(cache, `prefix-${target}`);
  const build = path.join(cache, `svt-${target}`);
  const nasm = process.env.NASM ?? (existsSync(path.join(cache, "nasm-2.16.03/nasm")) ? path.join(cache, "nasm-2.16.03/nasm") : "nasm");
  if (target === "x86_64") run(nasm, ["-v"], root, true);
  run(cmake, ["-S", svt, "-B", build, "-DCMAKE_BUILD_TYPE=Release", "-DBUILD_APPS=OFF", "-DBUILD_SHARED_LIBS=OFF", "-DBUILD_TESTING=OFF", "-DSVT_AV1_LTO=OFF", "-DCMAKE_POSITION_INDEPENDENT_CODE=ON", `-DCMAKE_OUTPUT_DIRECTORY=${path.join(build, "out")}`, `-DCMAKE_OSX_ARCHITECTURES=${target}`, "-DCMAKE_OSX_DEPLOYMENT_TARGET=12.0", `-DCMAKE_INSTALL_PREFIX=${prefix}`, ...(target === "x86_64" ? [`-DCMAKE_ASM_NASM_COMPILER=${nasm}`] : [])]);
  run(cmake, ["--build", build, "--parallel", "6"]); run(cmake, ["--install", build]);
  if (run("xcrun", ["lipo", "-archs", path.join(prefix, "lib/libSvtAv1Enc.a")], root, true) !== target) throw new Error("SVT archive architecture mismatch");
  const ffbuild = path.join(cache, `ff-${sources.ffmpeg.version}-${target}`); mkdirSync(ffbuild, { recursive: true });
  env.PP_SVT_PREFIX = prefix;
  const pkg = path.join(ffbuild, "pkg-config");
  writeFileSync(pkg, `#!${process.execPath}\nimport ${JSON.stringify(path.join(root, "scripts/macos-svt-pkg-config.mjs"))};\n`, { mode: 0o755 });
  // Node's generated extensionless shim must explicitly be ESM.
  writeFileSync(path.join(ffbuild, "package.json"), '{"type":"module"}\n');
  const flags = `-arch ${target} -mmacosx-version-min=12.0 -fPIC`;
  const options = ["--disable-autodetect", "--disable-everything", "--disable-programs", "--disable-doc", "--disable-network", "--disable-iconv", "--disable-securetransport", "--disable-videotoolbox", "--disable-shared", "--enable-static", "--enable-pic", "--disable-avformat", "--disable-avdevice", "--disable-avfilter", "--disable-swresample", "--enable-avcodec", "--enable-avutil", "--enable-swscale", "--enable-libsvtav1", "--enable-encoder=libsvtav1", "--disable-x86asm", `--arch=${target === "arm64" ? "aarch64" : target}`, "--target-os=darwin", "--enable-cross-compile", "--cc=clang", "--cxx=clang++", `--extra-cflags=${flags}`, `--extra-ldflags=${flags}`, `--pkg-config=${pkg}`, `--prefix=${prefix}`];
  const fingerprint = createHash("sha256").update(JSON.stringify([sources.ffmpeg, options])).digest("hex");
  const configured = path.join(ffbuild, "configuration.sha256");
  if (!existsSync(configured) || readFileSync(configured, "utf8") !== fingerprint) {
    run(path.join(ffmpeg, "configure"), options, ffbuild);
    writeFileSync(configured, fingerprint);
  }
  run("make", ["-j6"], ffbuild); run("make", ["install"], ffbuild);
  const exports = path.join(cache, "av1.exports");
  writeFileSync(exports, ["pp_av1_abi", "pp_av1_open", "pp_av1_encode", "pp_av1_close", "pp_av1_free"].map(name => `_${name}`).join("\n") + "\n");
  const library = path.join(cache, `libpastepanda_av1-${target}.dylib`);
  run("xcrun", ["clang", "-dynamiclib", "-O2", "-fvisibility=hidden", "-arch", target, "-mmacosx-version-min=12.0", `-I${prefix}/include`, "src-tauri/src/macos/av1_bridge.c", `${prefix}/lib/libavcodec.a`, `${prefix}/lib/libswscale.a`, `${prefix}/lib/libavutil.a`, `${prefix}/lib/libSvtAv1Enc.a`, "-lm", "-lpthread", "-Wl,-dead_strip", `-Wl,-exported_symbols_list,${exports}`, "-Wl,-install_name,@rpath/libpastepanda_av1.dylib", "-o", library]);
  libraries.push(library);
}
const library = path.join(runtime, "libpastepanda_av1.dylib");
if (libraries.length === 2) run("xcrun", ["lipo", "-create", ...libraries, "-output", library]);
else copyFileSync(libraries[0], library);
run("codesign", ["--force", "--sign", "-", library]);
run("codesign", ["--verify", "--strict", library]);
const actual = run("xcrun", ["lipo", "-archs", library], root, true).split(/\s+/).sort();
if (JSON.stringify(actual) !== JSON.stringify([...targets].sort())) throw new Error("AV1 library architecture mismatch");
const dependencies = run("otool", ["-L", library], root, true).split("\n").map(line => /^\s+(\S+)\s+\(compatibility/.exec(line)?.[1]).filter(file => file && file !== "@rpath/libpastepanda_av1.dylib");
if (dependencies.some(file => !file.startsWith("/usr/lib/") && !file.startsWith("/System/Library/"))) throw new Error("AV1 library has unbundled dependencies");
const licenses = path.join(runtime, "licenses"); mkdirSync(licenses, { recursive: true });
copyFileSync(path.join(ffmpeg, "COPYING.LGPLv2.1"), path.join(licenses, "FFmpeg-LGPL-2.1.txt"));
copyFileSync(path.join(svt, "LICENSE.md"), path.join(licenses, "SVT-AV1-LICENSE.md"));
copyFileSync(path.join(svt, "PATENTS.md"), path.join(licenses, "SVT-AV1-PATENTS.md"));
// Ship the exact unmodified sources and our bridge for the replaceable LGPL library.
for (const spec of Object.values(sources)) copyFileSync(path.join(cache, spec.file), path.join(licenses, spec.file));
copyFileSync(path.join(root, "src-tauri/src/macos/av1_bridge.c"), path.join(licenses, "av1_bridge.c"));
copyFileSync(path.join(root, "src-tauri/src/macos/av1_bridge.h"), path.join(licenses, "av1_bridge.h"));
for (const file of ["macos-av1-build.mjs", "macos-svt-pkg-config.mjs", "macos-av1-sources.json", "macos-av1-source-signature.mjs"]) copyFileSync(path.join(root, "scripts", file), path.join(licenses, file));
const signatures = path.join(licenses, "macos-av1"); mkdirSync(signatures, { recursive: true });
for (const file of [sources.ffmpeg.keyFile, sources.ffmpeg.signatureFile, "REBUILD.md"]) copyFileSync(path.join(root, "scripts/macos-av1", file), path.join(signatures, file));
writeFileSync(path.join(runtime, "manifest.json"), JSON.stringify({ architectures: actual, minimumSystemVersion: "12.0", sources, sourceLibrarySha256: createHash("sha256").update(readFileSync(library)).digest("hex") }, null, 2) + "\n");
console.log(`AV1 runtime ready: ${actual.join(" + ")}, ${library}`);
