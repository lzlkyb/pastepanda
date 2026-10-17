import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const source = readFileSync("src-tauri/src/rec/mod.rs", "utf8");

it("checks native exclusion after showing the control surface", () => {
  const control = source.slice(source.indexOf("pub fn open_control_window"), source.indexOf("fn restore_recording_focus"));
  const protection = control.indexOf("capture_exclusion::protect(&surface)");
  expect(protection).toBeGreaterThanOrEqual(0);
  expect(protection).toBeGreaterThan(control.indexOf("window.show()"));
});

it("checks the operating system result rather than only enqueueing a protection request", () => {
  const native = readFileSync("src-tauri/src/rec/capture_exclusion.rs", "utf8");
  expect(native).toContain("SetWindowDisplayAffinity");
  expect(native).toContain("GetWindowDisplayAffinity");
  expect(native).toContain("affinity != WDA_EXCLUDEFROMCAPTURE.0");
  expect(native).toContain("run_on_main_thread");
  expect(native).toContain("DwmFlush");
});

it("keeps displayed results beyond the unread-window safety timeout", () => {
  const hud = source.slice(source.indexOf("pub fn open_hud_window("), source.indexOf("fn primary_screen_metrics("));
  expect(hud).toContain("HUD_DATA.lock().unwrap_or_else(|p| p.into_inner()).is_some()");
});

it("waits for the old preview label to be released before constructing its replacement", () => {
  const preview = source.slice(source.indexOf("pub fn open_preview_window("), source.indexOf("pub fn open_hud_window("));
  const wait = preview.indexOf("while app.get_webview_window(PREVIEW_LABEL).is_some()");
  expect(preview).toContain("w.destroy()");
  expect(wait).toBeGreaterThan(0);
  expect(wait).toBeLessThan(preview.indexOf("WebviewWindowBuilder::new("));
  expect(preview).toContain("Duration::from_secs(2)");
});
