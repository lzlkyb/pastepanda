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
  it("穿透确认超时只算「未确认」，不能把已经建好的窗口判死", () => {
    // 2026-10-18 用户报「晾衣绳未能显示：timed out waiting on channel」。
    // 真因：非主线程 build() 只把 CreateWindow 投递进队列就返回，紧接着的穿透初始化
    // 排在它后面，WebView2 冷启动超过 3 秒 ⇒ recv_timeout 超时。旧代码用 `?` 把这条
    // 超时当建窗失败，NATIVE_READY 永远停在 false，窗口建好却永不显示。
    const window = source("clothesline/window.rs");
    const ensure = window.slice(window.indexOf("pub(crate) fn ensure"), window.indexOf("pub(crate) fn retry"));
    expect(ensure).toMatch(/if let Err\(error\) = set_pointer_passthrough\(&win, true\)/);
    // 换回 `?` 传播时这里会命中：那正是让窗口永久不可见的老写法。
    expect(ensure).not.toMatch(/set_pointer_passthrough\(&win, true\)\s*\n\s*\.map_err/);
    // 已有窗口但原生位没点亮时必须自愈（补投穿透 + 置位），而不是直接 return。
    const sync = window.slice(window.indexOf("pub(super) fn sync_visibility"), window.indexOf("pub(crate) fn ensure"));
    expect(sync).toMatch(
      /!NATIVE_READY\.load[\s\S]{0,200}set_pointer_passthrough\(&win, true\)[\s\S]{0,80}NATIVE_READY\.store\(true/,
    );
  });
  it("鼠标进入挂图区域的余量足够，不再要求 2px 精度", () => {
    // 窗口默认穿透，光标必须落进上报区域外扩 pad 内才切回可交互。
    // 2px 时用户「明明在图上却点不动」，实测就是这里。
    const window = source("clothesline/window.rs");
    expect(window).toContain("if inside { 10.0 } else { 8.0 }");
  });
  it("不再提供撤销条，也不再用全局在途状态锁住整根绳子的操作", () => {
    // 2026-10-18 体验收敛：撤销条与「一张在途全绳禁用」是「点不动 + 提示太多」的两大来源。
    const runtime = readFileSync("src/clothesline/runtime.mjs", "utf8");
    expect(runtime).not.toContain("undoBar");
    expect(runtime).not.toContain("setUndo");
    const gather = runtime.slice(runtime.indexOf('$("gather").disabled'), runtime.indexOf('$("clear").disabled'));
    expect(gather).not.toContain("taking.size");
    expect(gather).not.toContain("pendingHangs");
    expect(gather).not.toContain("state.pins.some");
    // 单卡按钮只能按「这一张」禁用，不能回退成全局在途判断。
    const cards = runtime.slice(runtime.indexOf('el.querySelector(".takeOne").disabled'), runtime.indexOf("geometryBusy"));
    expect(cards).toContain("taking.has(id)");
    expect(cards).not.toContain("taking.size");
    const html = readFileSync("clothesline.html", "utf8");
    expect(html).not.toContain('id="undoBar"');
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
