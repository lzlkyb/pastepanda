import { readFile } from "node:fs/promises";
import { expect, it } from "vitest";
import { patchAndroidGradle, patchAndroidManifest } from "./prepare-android.mjs";

async function nativeSource() {
  return readFile("src-tauri/android/MobileInteractionPlugin.kt", "utf8");
}

// Pin the ownership boundary: a native preview must never execute a second navigation path.
function assertBackOwnership(source: string) {
  expect(source).not.toMatch(/\.(?:goBack|onBackPressed|finish)\(/);
  expect(source).toContain('emit("commit", 1f)');
  expect(source).toContain('if (!eligible()) { cancelGesture(); return }');
  expect(source).toContain("requested && !paused && webView != null && !imeVisible");
}

it("native preview and commit never double-dispatch Tauri back, and IME/root retain platform ownership", async () => {
  assertBackOwnership(await nativeSource());
});

it("ownership guard rejects duplicate navigation and keyboard interception counterexamples", async () => {
  const source = await nativeSource();
  expect(() => assertBackOwnership(source + "\nactivity.onBackPressed()\n")).toThrow();
  expect(() => assertBackOwnership(source.replace(" && !imeVisible", ""))).toThrow();
  expect(() => assertBackOwnership(source.replace("if (!eligible()) { cancelGesture(); return }", ""))).toThrow();
});

it("predictive back has cancellation and old Android synthesizes start, with pause and destroy cleanup", async () => {
  const source = await nativeSource();
  expect(source).toContain("override fun handleOnBackStarted");
  expect(source).toContain("override fun handleOnBackProgressed");
  expect(source).toContain("override fun handleOnBackCancelled");
  expect(source).toContain('if (!gestureActive) { edge = "left"; emit("start", 0f) }');
  expect(source).toContain('emit("cancel", 0f)');
  expect(source).toContain("callback?.remove()");
  expect(source).toContain("removeOnGlobalLayoutListener(layoutListener)");
  expect(source).toContain("mobile-native-back");
});

it("semantic haptics use View defaults and respect system/user preference without VIBRATE permission", async () => {
  const source = await nativeSource();
  expect(source).toContain("Settings.System.HAPTIC_FEEDBACK_ENABLED");
  expect(source).toContain("view.isHapticFeedbackEnabled");
  expect(source).toContain("view?.hasWindowFocus() == true");
  expect(source).toContain("view.performHapticFeedback(feedback)");
  expect(source).not.toMatch(/performHapticFeedback\([^\n]*,/);
  expect(source).not.toContain("Vibrator");
});

it("clean generated Android projects install Activity predictive APIs idempotently", () => {
  const old = 'dependencies {\n implementation("androidx.appcompat:appcompat:1.7.0")\n implementation("androidx.activity:activity-ktx:1.6.0")\n}';
  const patched = patchAndroidGradle(old);
  expect(patched).toContain('implementation("androidx.activity:activity-ktx:1.10.1")');
  expect(patched.match(/androidx.activity:activity-ktx:/g)).toHaveLength(1);
  expect(patchAndroidGradle(patched)).toBe(patched);
  expect(patchAndroidGradle(patched.replace("activity-ktx:1.10.1", "activity-ktx:1.11.0"))).toContain("activity-ktx:1.11.0");
  const absent = old.replace(/\s*implementation\("androidx.activity[^\n]*/, "");
  expect(patchAndroidGradle(absent).split("activity-ktx:")).toHaveLength(2);
});

it("manifest opts only MainActivity into predictive back, preserving unrelated activities", () => {
  const source = '<manifest><application><activity android:name=".OtherActivity" android:enableOnBackInvokedCallback="false"/><activity android:name=".MainActivity" android:enableOnBackInvokedCallback="false"/></application></manifest>';
  const patched = patchAndroidManifest(source);
  expect(patched).toContain('android:name=".MainActivity" android:enableOnBackInvokedCallback="true"');
  expect(patched).toContain('android:name=".OtherActivity" android:enableOnBackInvokedCallback="false"');
  expect(patchAndroidManifest(patched)).toBe(patched);
  expect(patchAndroidManifest(source.replace('android:name=".MainActivity" android:enableOnBackInvokedCallback="false"', 'android:name=".MainActivity"'))).toContain('android:name=".MainActivity" android:enableOnBackInvokedCallback="true"');
});

it("Rust commands and preparation register the same tracked native bridge", async () => {
  const [prepare, commands, lib, bridge] = await Promise.all([
    readFile("scripts/prepare-android.mjs", "utf8"),
    readFile("src-tauri/src/commands/mod.rs", "utf8"),
    readFile("src-tauri/src/lib.rs", "utf8"),
    readFile("src-tauri/src/commands/mobile_interaction.rs", "utf8"),
  ]);
  expect(prepare).toContain('"MobileInteractionPlugin.kt"');
  expect(commands).toContain("pub mod mobile_interaction;");
  expect(lib).toContain(".plugin(commands::mobile_interaction::init())");
  expect(lib).toContain("commands::mobile_interaction_set,");
  expect(lib).toContain("commands::mobile_interaction_haptic,");
  expect(bridge).toContain('"MobileInteractionPlugin"');
});
