#!/usr/bin/env node
/**
 * Android 构建/联调入口（2026-10-02）：与桌面 dev **并行不抢占**。
 *
 * 🔴 背景：tauri android build/dev 与桌面 `tauri dev` 共用 `src-tauri/target/`，
 *    cargo 的构建锁是整个 target 目录级的——Android 一开编（CLI 还会先跑一遍
 *    `--no-default-features` 同步构建），桌面 dev 的 cargo 就被锁死甚至 watcher
 *    跑挂，此前只能杀桌面进程。本脚本给 Android 单独指 `CARGO_TARGET_DIR`
 *    （tauri CLI 经 cargo metadata 解析 target 目录，认这个变量），两边互不可见。
 *
 * 用法：
 *   node scripts/android-build.mjs                 # 打 debug APK（--target aarch64）
 *   node scripts/android-build.mjs --install       # 打完检测到真机就 adb install + 启动
 *   node scripts/android-build.mjs --release       # 打 release APK（自包含，真机/公网测试用）
 *   node scripts/android-build.mjs --release --install
 *   node scripts/android-build.mjs --dev           # tauri android dev（真机联调）
 *   额外参数原样透传给 tauri（如 `--target aarch64` 已默认带上，可覆盖）。
 *
 * 🔴 debug 包 = dev 模式：tauri.conf.json 的 `build.devUrl` 被烤进 APK，前端要从
 *    **电脑的 vite dev server** 拉，APK 自身一个 html 资产都没有。手机和电脑不在
 *    同一网络（手机走 5G / 别的 Wi-Fi）时打开 App 就是**白屏**。公网/脱离电脑的
 *    真机测试一律 `--release`。
 *
 * 一次性成本：target-android 首编全树约 10–20 分钟（release 另起一套 profile，
 * 首次同价）+ 数 GB 磁盘；之后增量秒级。桌面 dev 全程不用停。
 */
import { spawnSync } from "node:child_process";
import path from "node:path";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { prepareAndroid } from "./prepare-android.mjs";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const os = await import("node:os");
const argv = process.argv.slice(2);
const doInstall = argv.includes("--install");
const doDev = argv.includes("--dev");
const doRelease = argv.includes("--release");
const passthrough = argv.filter((a) => a !== "--install" && a !== "--dev" && a !== "--release");

// 标准环境配方（docs/dev-运行手册.md）。外部已设的以外部为准，便于机器迁移。
const ENV_DEFAULTS = {
  LIBCLANG_PATH: "D:\\AItool\\winapp\\pastePanda\\src-tauri\\.libclang",
  JAVA_HOME: "D:/AItool/jdk-17.0.20.1+1",
  ANDROID_HOME: "C:/Users/19145/AppData/Local/Android/Sdk",
  NDK_HOME: "C:/Users/19145/AppData/Local/Android/Sdk/ndk/27.2.12479018",
  CC_aarch64_linux_android:
    "C:/Users/19145/AppData/Local/Android/Sdk/ndk/27.2.12479018/toolchains/llvm/prebuilt/windows-x86_64/bin/aarch64-linux-android24-clang.cmd",
  CXX_aarch64_linux_android:
    "C:/Users/19145/AppData/Local/Android/Sdk/ndk/27.2.12479018/toolchains/llvm/prebuilt/windows-x86_64/bin/aarch64-linux-android24-clang++.cmd",
  AR_aarch64_linux_android:
    "C:/Users/19145/AppData/Local/Android/Sdk/ndk/27.2.12479018/toolchains/llvm/prebuilt/windows-x86_64/bin/llvm-ar.exe",
  BINDGEN_EXTRA_CLANG_ARGS_aarch64_linux_android:
    "--sysroot=C:/Users/19145/AppData/Local/Android/Sdk/ndk/27.2.12479018/toolchains/llvm/prebuilt/windows-x86_64/sysroot" +
    " -IC:/Users/19145/AppData/Local/Android/Sdk/ndk/27.2.12479018/toolchains/llvm/prebuilt/windows-x86_64/lib/clang/18/include" +
    " -IC:/Users/19145/AppData/Local/Android/Sdk/ndk/27.2.12479018/toolchains/llvm/prebuilt/windows-x86_64/sysroot/usr/include" +
    " -IC:/Users/19145/AppData/Local/Android/Sdk/ndk/27.2.12479018/toolchains/llvm/prebuilt/windows-x86_64/sysroot/usr/include/aarch64-linux-android",
  CARGO_TARGET_AARCH64_LINUX_ANDROID_LINKER:
    "C:/Users/19145/AppData/Local/Android/Sdk/ndk/27.2.12479018/toolchains/llvm/prebuilt/windows-x86_64/bin/aarch64-linux-android24-clang.cmd",
};

const env = {
  ...process.env,
  // 🔴 无条件覆盖，**不要**改成「未设才生效」：系统里可能有全局 JAVA_HOME 指
  //    老 JDK（本机 NC65 残留 1.7），会让 gradlew 直接拒绝运行（实测）。要换
  //    机器改 ENV_DEFAULTS，或在命令行显式传同名变量后改这里尊重它。
  ...ENV_DEFAULTS,
  // 🔴 与桌面 target/ 分离的开关本体
  CARGO_TARGET_DIR: path.join(root, "src-tauri", "target-android"),
};

const gradleDir = path.join(root, "src-tauri", "gen", "android");
const gradlew = path.join(gradleDir, "gradlew.bat");
// 在 Gradle 启动前恢复 Kotlin 类，确保全新 init 与已有工程行为一致。
await prepareAndroid(root);

// 🔴 先停 gradle daemon：daemon 只认**启动时**的 env，不重启就看不到上面注入的
//    CARGO_TARGET_DIR，它内部的 rustBuild* 任务会把树又编回旧 target/。
spawnSync(gradlew, ["--stop", "--project-dir", gradleDir], { stdio: "inherit", env, shell: true });

// 🔴 build 类型：不加参数 = release（tauri CLI 默认，用 `build.frontendDist` 打包，
//    产物自包含、可脱离电脑 dev server 运行）；`--debug` 才是 dev 模式（devUrl 生效）。
//    ⚠️ 没有 `--release` 这个参数，传了 CLI 直接报 unexpected argument。
const buildArgs = ["--apk", "--target", "aarch64", ...(doRelease ? [] : ["--debug"]), ...passthrough];
const npmArgs = doDev
  ? ["run", "tauri", "android", "dev", "--", ...passthrough]
  : ["run", "tauri", "android", "build", "--", ...buildArgs];
console.log(`[android-build] npm ${npmArgs.join(" ")}`);
const build = spawnSync("npm", npmArgs, { stdio: "inherit", env, shell: true, cwd: root });
if (build.status !== 0) process.exit(build.status ?? 1);
if (!doDev && (doInstall || doRelease)) {
  // release 的产物是 **未签名** APK，装不上也发不了；用长期 keystore 现签一份。
  // （gen/android 的 release 构建类型没有 signingConfig，tauri CLI 也没有签名选项。）
  // 🔴 签名不挂在 --install 下：publish-apk 走的「只打包不装机」路径同样要签名包。
  let apk = path.join(
    gradleDir,
    "app",
    "build",
    "outputs",
    "apk",
    "universal",
    "debug",
    "app-universal-debug.apk",
  );
  if (doRelease) {
    const unsigned = path.join(
      gradleDir,
      "app",
      "build",
      "outputs",
      "apk",
      "universal",
      "release",
      "app-universal-release-unsigned.apk",
    );
    if (!existsSync(unsigned)) {
      console.error(`[android-build] release APK 不存在：${unsigned}`);
      process.exit(1);
    }
    apk = path.join(
      gradleDir,
      "app",
      "build",
      "outputs",
      "apk",
      "universal",
      "release",
      "app-universal-release.apk",
    );
    const sdk = ENV_DEFAULTS.ANDROID_HOME;
    const buildTools = existsSync(path.join(sdk, "build-tools"))
      ? readdirSync(path.join(sdk, "build-tools"))
          .filter((d) => /^\d/.test(d))
          .sort()
          .at(-1)
      : null;
    if (!buildTools) {
      console.error(`[android-build] 找不到 build-tools（apksigner）: ${sdk}`);
      process.exit(1);
    }
    // 🔴 长期 release keystore（2026-10-03）。方案甲要求升级安装新旧 APK **同签名**，
    //    绝不允许静默回落 debug keystore——签错一次的后果是下个正式版全量用户
    //    装不上（SignatureMismatch），所以缺 key 直接红灯，不做兜底。
    //    主副本在 `~/.pastepanda/`（仓库外）；丢了 = 旧签名 APK 永久无法升级。
    const ksPropsPath = path.join(os.homedir(), ".pastepanda", "keystore.properties");
    if (!existsSync(ksPropsPath)) {
      console.error(
        `[android-build] 缺少长期签名配置：${ksPropsPath}\n` +
          "  需要 keystore.properties（storeFile/storePassword/keyAlias/keyPassword）。",
      );
      process.exit(1);
    }
    const ksProps = Object.fromEntries(
      readFileSync(ksPropsPath, "utf8")
        .split(/\r?\n/)
        .filter((l) => l.includes("="))
        .map((l) => [l.slice(0, l.indexOf("=")).trim(), l.slice(l.indexOf("=") + 1).trim()]),
    );
    const ks = ksProps.storeFile.replace(/\\\\/g, "\\");
    if (!existsSync(ks)) {
      console.error(`[android-build] keystore 文件不存在：${ks}`);
      process.exit(1);
    }
    // 🔴 2026-10-09：这里原先执行 apksigner.bat 并配 `shell: true`（Windows 直接 spawn .bat 会
    //    ENOENT，所以那个开关当时省不掉）。两个问题叠在一起：Node 的 shell 模式**不转义 args，
    //    只做拼接**，而口令是以 `pass:xxx` 形态拼进命令串的——口令里出现 `&` `^` `%` 会断句甚至
    //    注入；就算不炸，明文口令也进了 argv，同机任何进程列进程表就能读到。
    //    改法：绕开 .bat 直连 java（shell 不再需要 ⇒ 没有拼接），口令改用 apksigner 自带的
    //    `env:` 引用，只进子进程环境、不进命令行。
    //    实测 build-tools 35.0.0 + JDK 17：签名产物与 .bat 版同尺寸，证书仍是长期 keystore 的
    //    bcf9e0bf…。gradlew / npm 那两处仍是 .bat/.cmd，仍要 shell，不在这条范围内。
    const signerJar = path.join(sdk, "build-tools", buildTools, "lib", "apksigner.jar");
    const javaBin = path.join(env.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java");
    if (!existsSync(signerJar) || !existsSync(javaBin)) {
      console.error(
        `[android-build] 找不到 apksigner.jar 或 java.exe：\n  ${signerJar}\n  ${javaBin}`,
      );
      process.exit(1);
    }
    const sign = spawnSync(
      javaBin,
      [
        "-cp",
        signerJar,
        "com.android.apksigner.ApkSignerTool",
        "sign",
        "--ks",
        ks,
        "--ks-pass",
        "env:PP_APK_KS_PASS",
        "--key-pass",
        "env:PP_APK_KEY_PASS",
        "--ks-key-alias",
        ksProps.keyAlias,
        "--out",
        apk,
        unsigned,
      ],
      {
        stdio: "inherit",
        env: {
          ...env,
          PP_APK_KS_PASS: ksProps.storePassword,
          PP_APK_KEY_PASS: ksProps.keyPassword || ksProps.storePassword,
        },
      },
    );
    if (sign.status !== 0) process.exit(sign.status ?? 1);
    console.log(`[android-build] 已用长期 keystore 签名（${ksProps.keyAlias}）：${apk}`);
  }
  if (!existsSync(apk)) {
    console.error(`[android-build] APK 不存在：${apk}`);
    process.exit(1);
  }
  if (!doInstall) {
    console.log(`[android-build] 只打包模式，产物：${apk}`);
    process.exit(0);
  }
  const adb = path.join(ENV_DEFAULTS.ANDROID_HOME, "platform-tools", "adb.exe");
  const devices = spawnSync(adb, ["devices"], { encoding: "utf8" }).stdout ?? "";
  const online = devices
    .split("\n")
    .slice(1)
    .some((l) => l.trim().endsWith("\tdevice"));
  if (!online) {
    console.log("[android-build] 未检测到在线真机，跳过安装。手机连上后手动：");
    console.log(`  ${adb} install -r "${apk}"`);
  } else {
    for (const step of [
      ["install", "-r", apk],
      ["shell", "am", "start", "-n", "com.pastepanda.app/.MainActivity"],
    ]) {
      const r = spawnSync(adb, step, { stdio: "inherit" });
      if (r.status !== 0) process.exit(r.status ?? 1);
    }
    console.log("[android-build] 安装并启动完成");
  }
}
