import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
const source = (file: string) => readFileSync("src-tauri/src/" + file, "utf8");
describe("晾衣绳桌面边界", () => {
  it("页面 ready 与原生初始化成功必须都满足，初始化不能只回报排队成功", () => {
    const window = source('clothesline/window.rs');
    const helper = window.slice(window.indexOf('fn set_pointer_passthrough'), window.indexOf('fn raise_above_desktop'));
    expect(helper).toContain('recv_timeout');
    expect(window).toContain('NATIVE_READY.load');
    const ensure = window.slice(window.indexOf('pub(crate) fn ensure'), window.indexOf('pub(crate) fn retry'));
    expect(ensure.indexOf('NATIVE_READY.store(true')).toBeGreaterThan(ensure.indexOf('set_pointer_passthrough(&win, true)'));
    const wait = window.slice(window.indexOf('pub(crate) async fn wait_ready'), window.indexOf('pub(crate) fn hide('));
    expect(wait).toContain('!NATIVE_READY.load');
  });
  it("延迟与即时桌面检查串行，不能用旧桌面结果覆盖新应用焦点", () => {
    const desktop = source('clothesline/desktop.rs');
    expect(desktop).toMatch(/static REFRESH:\s*std::sync::Mutex<\(\)>/);
    const refresh = desktop.slice(desktop.indexOf('fn refresh('), desktop.indexOf('unsafe extern "system" fn foreground'));
    expect(refresh).toContain('let _refresh = REFRESH.lock()');
    expect(refresh.indexOf('let _refresh')).toBeLessThan(refresh.indexOf('GetForegroundWindow()'));
    expect(refresh.indexOf('let _refresh')).toBeLessThan(refresh.indexOf('DESKTOP.store'));
    expect(refresh).not.toContain('drop(_refresh)');
  });
  it("桌面焦点变化时抬到桌面前且不激活窗口，显示仍在桌面门控之后", () => {
    const window = source("clothesline/window.rs");
    const sync = window.slice(window.indexOf('pub(super) fn sync_visibility'),window.indexOf('pub(crate) fn ensure'));
    expect(sync).toContain('raise_above_desktop');
    expect(sync.indexOf('raise_above_desktop')).toBeGreaterThan(sync.indexOf('if !show'));
    const raise = window.slice(window.indexOf('fn raise_above_desktop'),window.indexOf('pub(super) fn sync_visibility'));
    expect(raise).toContain('HWND_TOP');expect(raise).toContain('SWP_NOACTIVATE');
    expect(raise).not.toContain('HWND_TOPMOST');
  });
  it("鼠标穿透的分层窗口必须初始化可见透明度并统一处理所有出口", () => {
    const window = source("clothesline/window.rs");
    const helper = window.slice(window.indexOf("fn set_pointer_passthrough("), window.indexOf("pub(super) fn sync_visibility"));
    expect(helper).toContain("run_on_main_thread");
    expect(helper).toMatch(/SetLayeredWindowAttributes\([\s\S]*?255,[\s\S]*?LWA_ALPHA/);
    expect(window.match(/\.set_ignore_cursor_events\(/g)).toHaveLength(2); // Windows wrapper and non-Windows fallback only.
  });
  it("点击穿透桌面也能通过前台切换关闭预览", () => {
    expect(source("clothesline/desktop.rs")).toContain('"clothesline-preview-dismiss"');
    expect(readFileSync("src/clothesline/bridge.mjs", "utf8")).toContain("getCurrentWindow().setFocus()");
  });
  it("取下贴图不沿用缩略图目标框的比例", () => {
    const pin = source("pinned_window.rs");
    expect(pin).not.toMatch(/s\.rect\.width\s+as\s+f32\s*\/\s*img_width/);
    expect(pin).toContain("actual_pin_rect");
  });
  it("所有显示出口统一走桌面门控，切换前台由事件驱动恢复", () => {
    const window = source("clothesline/window.rs");
    expect(window).toContain(".always_on_top(false)");
    expect(window).toContain("desktop::can_show");
    expect(source("clothesline/mod.rs")).toContain("desktop::install(app)");
    expect(window.match(/win\.show\(\)/g)).toHaveLength(1);
    const drag = window.slice(window.indexOf("pub fn pin_drag("), window.indexOf("pub fn pin_drag_cancel"));
    expect(drag).toContain("desktop::is_desktop()");
  });
  it("双击贴图不会隐式进入截图，右键重新编辑仍可显式调用", () => {
    const pin = source("pinned_window.rs");
    const doubleClick = pin.slice(pin.indexOf("WM_LBUTTONDBLCLK =>"), pin.indexOf("WM_RBUTTONUP =>"));
    expect(doubleClick).not.toContain("open_editor_window");
    const menu = pin.slice(pin.indexOf("WM_RBUTTONUP =>"), pin.indexOf("WM_DESTROY =>"));
    expect(menu).toContain("重新编辑");
    expect(menu).toContain("open_editor_window");
    expect(pin).toContain("WS_EX_TOPMOST");
  });
});
