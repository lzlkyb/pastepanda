import { copyFile, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import path from "node:path";
import { fileURLToPath } from "node:url";

const permissions = ["CAMERA", "FOREGROUND_SERVICE", "FOREGROUND_SERVICE_SPECIAL_USE", "POST_NOTIFICATIONS", "WAKE_LOCK", "ACCESS_WIFI_STATE", "ACCESS_NETWORK_STATE", "REQUEST_INSTALL_PACKAGES"];
const service = `        <service android:name=".RcSessionForegroundService" android:exported="false" android:foregroundServiceType="specialUse">
            <property android:name="android.app.PROPERTY_SPECIAL_USE_FGS_SUBTYPE" android:value="remote_desktop_session_keepalive" />
        </service>`;

/** 仅补本项目的原生声明，保留 Tauri 生成的 Activity、intent 和其他插件。 */
export function patchAndroidManifest(manifest) {
  if (!/<application\b/.test(manifest) || !manifest.includes("</application>")) {
    throw new Error("AndroidManifest.xml 缺少 application，无法恢复原生插件");
  }
  const declared = new Set([...manifest.matchAll(/<uses-permission\b[^>]*android:name\s*=\s*["']([^"']+)["']/g)].map(match => match[1]));
  const missing = permissions.filter(name => !declared.has(`android.permission.${name}`))
    .map(name => `    <uses-permission android:name="android.permission.${name}" />`);
  if (!/<uses-feature\b[^>]*android:name\s*=\s*["']android\.hardware\.camera["']/.test(manifest)) {
    missing.push('    <uses-feature android:name="android.hardware.camera" android:required="false" />');
  }
  if (missing.length) manifest = manifest.replace(/([ \t]*)<application\b/, `${missing.join("\n")}\n\n$1<application`);
  if (!/<service\b[^>]*android:name\s*=\s*["'](?:\.RcSessionForegroundService|com\.pastepanda\.app\.RcSessionForegroundService)["']/.test(manifest)) {
    manifest = manifest.replace(/([ \t]*)<\/application>/, `${service}\n$1</application>`);
  }
  if (!manifest.includes('knowledge-share-inbox')) {
    const filter = `<!-- knowledge-share-inbox: explicit system sharing, no clipboard scanning -->
            <intent-filter>
                <action android:name="android.intent.action.SEND" />
                <action android:name="android.intent.action.SEND_MULTIPLE" />
                <category android:name="android.intent.category.DEFAULT" />
                <data android:mimeType="text/plain" />
                <data android:mimeType="image/*" />
            </intent-filter>`;
    // Some clean test/init templates use a self-closing MainActivity.
    manifest = manifest.replace(/<activity\b([^>]*android:name=["'](?:\.MainActivity|com\.pastepanda\.app\.MainActivity)["'][^>]*)\/>/, `<activity$1>${filter}</activity>`);
    const activity = /(<activity\b[^>]*android:name=["'](?:\.MainActivity|com\.pastepanda\.app\.MainActivity)["'][^>]*>)([\s\S]*?)(<\/activity>)/;
    if (!manifest.includes('knowledge-share-inbox')) manifest = manifest.replace(activity, `$1$2\n            ${filter}\n        $3`);
    if (!manifest.includes('knowledge-share-inbox')) throw new Error("清单里找不到 MainActivity，无法登记系统收集入口");
  }
  if (!manifest.includes('androidx.core.content.FileProvider')) {
    manifest = manifest.replace('</application>', `<provider android:name="androidx.core.content.FileProvider" android:authorities="\${applicationId}.fileprovider" android:exported="false" android:grantUriPermissions="true">
            <meta-data android:name="android.support.FILE_PROVIDER_PATHS" android:resource="@xml/file_paths" />
        </provider></application>`);
  }
  return manifest;
}

/** gen/android/app/build.gradle.kts 不在版本控制里，`tauri android init` 重新生成后
 *  也不会带 androidx.core——ApkInstallerPlugin 的 FileProvider 编译需要它。幂等补一行。 */
export function patchAndroidGradle(gradle) {
  if (/androidx\.core[:/]/.test(gradle)) return gradle;
  const anchor = gradle.match(/.*implementation\("androidx\.appcompat:appcompat[^"]*"\).*/);
  if (!anchor) throw new Error("build.gradle.kts 里找不到 appcompat 依赖行，无法注入 androidx.core");
  return gradle.replace(anchor[0], `${anchor[0]}\n    implementation("androidx.core:core:1.13.1")`);
}

/** Android 不能执行应用可写目录的文件；原生承载随 APK 从 nativeLibraryDir 运行。 */
export function patchUnderlayNativePackaging(gradle) {
  if (gradle.includes('jniLibs.useLegacyPackaging = true')) return gradle;
  if (!gradle.includes('android {')) throw new Error('找不到 Android 打包配置');
  return gradle.replace('android {', 'android {\n    packaging {\n        jniLibs.useLegacyPackaging = true\n        jniLibs.keepDebugSymbols.add("**/libeasytier.so")\n    }');
}

/** gen/ 不入库：每次 Android 构建前从版本控制中的唯一源恢复。 */
export async function prepareAndroid(root) {
  const main = path.join(root, "src-tauri/gen/android/app/src/main");
  // 平台资源覆盖不会删除历史生成文件；只移除我们误带入的三个 Windows 文件。
  for (const name of ["easytier-core.exe", "easytier-cli.exe", "build.json"]) {
    await rm(path.join(main, "assets/resources/easytier/windows-x86_64", name), { force: true });
  }
  const manifestPath = path.join(main, "AndroidManifest.xml");
  let manifest;
  try { manifest = await readFile(manifestPath, "utf8"); }
  catch (error) {
    if (error.code === "ENOENT") throw new Error("请先运行 npm run tauri android init，再执行 Android 构建");
    throw error;
  }
  const patched = patchAndroidManifest(manifest);
  const java = path.join(main, "java/com/pastepanda/app");
  await mkdir(java, { recursive: true });
  for (const name of ["MainActivity.kt", "RcSessionDisplay.kt", "RcKeepalivePlugin.kt", "RcSessionForegroundService.kt", "ApkInstallerPlugin.kt", "IrohNetworkPlugin.kt", "KnowledgeShareStore.kt", "KnowledgeSharePlugin.kt"]) {
    await copyFile(path.join(root, "src-tauri/android", name), path.join(java, name));
  }
  if (patched !== manifest) await writeFile(manifestPath, patched, "utf8");
  const xml = path.join(main, "res/xml");
  await mkdir(xml, { recursive: true });
  const filePaths = path.join(xml, "file_paths.xml");
  let paths;
  try { paths = await readFile(filePaths, "utf8"); }
  catch (error) { if (error.code !== "ENOENT") throw error; paths = '<paths xmlns:android="http://schemas.android.com/apk/res/android"><cache-path name="my_cache_images" path="." /></paths>'; }
  if (!paths.includes('name="knowledge_share_out"')) {
    paths = paths.replace('</paths>', '<cache-path name="knowledge_share_out" path="knowledge-share-out/" /></paths>');
    await writeFile(filePaths, paths, "utf8");
  }
  const gradlePath = path.join(root, "src-tauri/gen/android/app/build.gradle.kts");
  const gradle = await readFile(gradlePath, "utf8");
  const gradlePatched = patchAndroidGradle(gradle);
  if (gradlePatched !== gradle) await writeFile(gradlePath, gradlePatched, "utf8");
  const nativeSource = path.join(root, "src-tauri/resources/easytier/android-arm64/libeasytier.so");
  let native;
  try { native = await readFile(nativeSource); }
  catch (error) { if (error.code !== "ENOENT") throw error; }
  if (native) {
    const sha = createHash("sha256").update(native).digest("hex");
    if (sha !== "7bd504e87cad52edacb9ea84ece7397d0afb911101de623a3dfc4a4dbd9e6bb6") throw new Error("EasyTier 原生组件校验失败");
    const nativeDir = path.join(main, "jniLibs/arm64-v8a");
    await mkdir(nativeDir, { recursive: true });
    await copyFile(nativeSource, path.join(nativeDir, "libeasytier.so"));
    const noticeDir = path.join(main, "assets/easytier");
    await mkdir(noticeDir, { recursive: true });
    for (const name of ["LICENSE", "COPYING-GPL-3.0.txt", "pnet-LICENSE-MIT.txt", "pnet-LICENSE-APACHE.txt", "NOTICE.txt"]) {
      await copyFile(path.join(root, "src-tauri/resources/easytier", name), path.join(noticeDir, name));
    }
    const packaging = patchUnderlayNativePackaging(gradlePatched);
    if (packaging !== gradlePatched) await writeFile(gradlePath, packaging, "utf8");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  await prepareAndroid(path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."));
  console.log("[android-prepare] 原生源码与清单已同步");
}
