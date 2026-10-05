import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, copyFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expect, it } from "vitest";
import { patchAndroidManifest, patchUnderlayNativePackaging, prepareAndroid } from "./prepare-android.mjs";

it("备用承载从 Android 原生目录提取，重复打包不重复配置", () => {
  const source = 'android {\n    compileSdk = 36\n}\n';
  const patched = patchUnderlayNativePackaging(source);
  expect(patched).toContain('jniLibs.useLegacyPackaging = true');
  expect(patched).toContain('**/libeasytier.so');
  expect(patchUnderlayNativePackaging(patched)).toBe(patched);
});

const fresh = `<manifest xmlns:android="http://schemas.android.com/apk/res/android">
  <uses-permission android:name="android.permission.INTERNET" />
  <application android:label="PastePanda"><activity android:name=".MainActivity" /><provider android:name="other.Provider" /></application>
</manifest>`;

it("所有自持移动插件必须保留 release 反射命令", async () => {
  const sourceDir = path.resolve("src-tauri/android");
  for (const name of await readdir(sourceDir)) {
    if (!name.endsWith(".kt")) continue;
    const source = await readFile(path.join(sourceDir, name), "utf8");
    if (!/class\s+\w+[^\n]*:\s*Plugin\(/.test(source)) continue;
    expect(source, `${name} 缺少 TauriPlugin，R8 会移除 @Command`).toMatch(/@TauriPlugin\s+class\s/);
  }
});

it("观看保活必须同时管理前台防熄屏，并从同一源码复制进 APK", async () => {
  const source = await readFile(path.resolve("src-tauri/android/RcKeepalivePlugin.kt"), "utf8");
  expect(source).toContain("activity.runOnUiThread");
  expect(source).toMatch(/if \(args\.on\) \{\s*activity\.window\.addFlags\(WindowManager\.LayoutParams\.FLAG_KEEP_SCREEN_ON\)/);
  expect(source).toMatch(/else \{\s*activity\.window\.clearFlags\(WindowManager\.LayoutParams\.FLAG_KEEP_SCREEN_ON\)/);
});

it("全新 Android 清单恢复保活与相机声明，重复执行不重复注入", () => {
  const restored = patchAndroidManifest(fresh);
  expect(new DOMParser().parseFromString(restored, "application/xml").querySelector("parsererror")).toBeNull();
  expect(restored).toContain('android:foregroundServiceType="specialUse"');
  expect(restored).toContain('android:exported="false"');
  expect(restored).toContain("FOREGROUND_SERVICE_SPECIAL_USE");
  expect(restored).toContain("ACCESS_NETWORK_STATE");
  expect(restored).toContain('android.hardware.camera" android:required="false"');
  expect(restored).toContain('android:name="other.Provider"');
  expect(patchAndroidManifest(restored)).toBe(restored);
});

it("现有完整包名的服务声明不会重复，失效清单直接报错", () => {
  const restored = patchAndroidManifest(fresh).replace(".RcSessionForegroundService", "com.pastepanda.app.RcSessionForegroundService");
  expect(patchAndroidManifest(restored)).toBe(restored);
  expect(() => patchAndroidManifest("<manifest />")).toThrow("application");
});

it("从纳入版本控制的源码恢复插件，覆盖生成目录的过期副本", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "pastepanda-android-"));
  try {
    const main = path.join(root, "src-tauri/gen/android/app/src/main");
    const sources = path.join(root, "src-tauri/android");
    await mkdir(main, { recursive: true }); await mkdir(sources, { recursive: true });
    await writeFile(path.join(main, "AndroidManifest.xml"), fresh);
    await mkdir(path.join(root, "src-tauri/gen/android/app"), { recursive: true });
    await writeFile(
      path.join(root, "src-tauri/gen/android/app/build.gradle.kts"),
      'dependencies {\n    implementation("androidx.appcompat:appcompat:1.7.0")\n}\n'
    );
    for (const name of ["RcKeepalivePlugin.kt", "RcSessionForegroundService.kt", "ApkInstallerPlugin.kt", "IrohNetworkPlugin.kt"]) {
      await copyFile(path.resolve("src-tauri/android", name), path.join(sources, name));
    }
    await prepareAndroid(root);
    const plugin = path.join(main, "java/com/pastepanda/app/RcKeepalivePlugin.kt");
    expect(await readFile(plugin, "utf8")).toContain("class RcKeepalivePlugin");
    expect(await readFile(plugin, "utf8")).toContain("FLAG_KEEP_SCREEN_ON");
    const networkPlugin = path.join(main, "java/com/pastepanda/app/IrohNetworkPlugin.kt");
    expect(await readFile(networkPlugin, "utf8")).toContain("class IrohNetworkPlugin");
    await writeFile(networkPlugin, "stale");
    await writeFile(plugin, "stale");
    await prepareAndroid(root);
    expect(await readFile(plugin, "utf8")).toContain("class RcKeepalivePlugin");
    expect(await readFile(plugin, "utf8")).toContain("FLAG_KEEP_SCREEN_ON");
    expect(await readFile(networkPlugin, "utf8")).toContain("registerDefaultNetworkCallback");
    expect(await readFile(path.join(main, "AndroidManifest.xml"), "utf8")).toContain("RcSessionForegroundService");
  } finally {
    // Only remove this test's freshly allocated directory under the system temp root.
    if (path.dirname(root) === path.resolve(os.tmpdir()) && path.basename(root).startsWith("pastepanda-android-")) await rm(root, { recursive: true, force: true });
  }
});
