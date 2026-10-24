import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
const source = (file: string) => readFileSync(new URL("../../src-tauri/src/" + file, import.meta.url), "utf8");
describe("晾衣绳原生接收协议", () => {
  it("所有晾衣绳IPC注册都必须限制桌面平台，不能引用移动端未编译的模块", () => {
    const lib = source('lib.rs');
    const registry = lib.slice(lib.indexOf('commands::open_pinned_image,'),lib.indexOf('commands::close_pinned_image,'));
    const registrations = [...registry.matchAll(/(?:#\[cfg\(desktop\)\]\s*)?clothesline::clothesline_\w+,/g)].map(match => match[0]);
    expect(registrations.length).toBeGreaterThan(0);
    expect(registrations.filter(entry => !entry.startsWith('#[cfg(desktop)]'))).toEqual([]);
  });
  it("松手桌面判定明确忽略自家绳层，OLE无目标时必须核对实际底层窗口", () => {
    const native = source('pinned_transfer.rs');
    expect(native).toContain('scan.ignored_window == Some(hwnd.0 as isize)');
    expect(native).toContain('crate::pin_drag_policy::desktop_release');
    const pin = source('pinned_window.rs');
    const landing = pin.slice(pin.indexOf('pub fn clothesline_land_transfer'),pin.indexOf('unsafe fn prepare_transfer'));
    expect(landing).toContain('desktop_at(POINT');
    expect(landing).toContain('}, rope_window)');
    expect(landing).toContain('get_webview_window("clothesline")');
  });
  it("晾衣绳贴图再次裸拖也使用小图交付路径，桌面落图统一居中", () => {
    const pin = source('pinned_window.rs');
    const move = pin.slice(pin.indexOf('WM_MOUSEMOVE =>'), pin.indexOf('WM_MOUSELEAVE =>'));
    expect(move).toContain('state.clothesline_pin');
    expect(pin.match(/centered_origin\(/g)?.length).toBeGreaterThanOrEqual(2);
    expect(source('pinned_transfer.rs')).toContain('preview:');
  });
  it("捕获被打断要清理拖动态，系统移动退出仅在左键松开时才确认挂回", () => {
    const pin=source('pinned_window.rs');
    const cancel=pin.slice(pin.indexOf('WM_CANCELMODE |'),pin.indexOf('WM_MOUSEMOVE =>'));
    expect(cancel).toContain('state.dragging = false');expect(cancel).toContain('state.transfer_armed = false');
    expect(cancel).toContain('DefWindowProcW(hwnd, msg, wparam, lparam)');
    const end=pin.slice(pin.indexOf('WindowsAndMessaging::WM_EXITSIZEMOVE =>'),pin.indexOf('WM_CLOTHESLINE_SHOW |'));
    expect(end).toContain('should_commit_pin_move');expect(end).toContain('GetAsyncKeyState');
  });
  it("隐藏的接力窗口初始化尺寸时不能激活窗口抢走浏览器捕获", () => {
    const pin = source('pinned_window.rs');
    const sizing = pin.slice(pin.indexOf('// 把**客户区**调成真正的'), pin.indexOf('// 小圆角：'));
    expect(sizing).toMatch(/SWP_NOMOVE\s*\|\s*SWP_NOZORDER\s*\|\s*SWP_NOACTIVATE/);
    expect(pin).toContain('if startup.is_some(){WS_POPUP}else{WS_POPUP | WS_VISIBLE}');
    expect(source('clothesline/desktop.rs')).toContain('let next = on_desktop_context(&class, surface || rope || pin, inactive)');
  });
  it("贴图重绘必须复用像素且显示兜底不能销毁待接力的交付数据", () => {
    const pin = source('pinned_window.rs');
    const paint = pin.slice(pin.indexOf('unsafe fn paint_frame'),pin.indexOf('unsafe fn apply_round_region'));
    expect(paint).toContain('pixel_refresh_needed');
    const show = pin.slice(pin.indexOf('WM_CLOTHESLINE_SHOW | WM_CLOTHESLINE_CLOSE =>'),pin.indexOf('WM_LBUTTONUP =>'));
    expect(show).toMatch(/if lparam\.0 == 0\s*\{[\s\S]*?state\.prepared_transfer = None/);
  });
  it("原生交付期间只穿透鼠标，不隐藏桌面绳层", () => {
    const window = source("clothesline/window.rs");
    const guard = window.slice(window.indexOf("impl DragGuard"), window.indexOf("impl CaptureGuard"));
    expect(guard).not.toContain("hide_for_capture");
    expect(guard).not.toContain("captures");
    expect(guard).toContain("transfers");
  });
  it("缩略图解码离开命令线程，连续拖放准备完成后才确认窗口", () => {
    const images = source("commands/images.rs");
    expect(images).toMatch(/pub async fn get_image_thumbnail/);
    expect(images).toMatch(/pub async fn get_image_data_url/);
    const thumbnail = images.slice(images.indexOf("pub async fn get_image_thumbnail"), images.indexOf("pub fn get_image_info"));
    expect(thumbnail).toContain("spawn_blocking");
    const pin = source("pinned_window.rs");
    const startup = pin.slice(pin.indexOf("if let Some(startup)=startup {"));
    expect(startup.indexOf("prepare_transfer")).toBeGreaterThanOrEqual(0);
    expect(startup.indexOf("prepare_transfer")).toBeLessThan(startup.indexOf("startup.sender.send"));
  });
  it("缩略图复用已优化的缩放模块，鼠标穿透判断统一包含交付状态", () => {
    expect(source("commands/images.rs")).toContain("pastepanda_rc_scale::rgba_thumbnail");
    const model = source("clothesline/model.rs");
    expect(model.slice(model.indexOf("pub fn hit"), model.indexOf("pub fn valid_anchors"))).toContain("self.transfers == 0");
  });
  it("缩略图 SIMD 仅在已声明依赖的平台使用，提前松手验证目标屏幕", () => {
    const images = source("commands/images.rs");
    expect(images).toMatch(/#\[cfg\(windows\)\][\s\S]{0,220}pastepanda_rc_scale::rgba_thumbnail/);
    expect(images).toMatch(/#\[cfg\(not\(windows\)\)\][\s\S]{0,120}resize_exact/);
    const pin = source("pinned_window.rs");
    const landing = pin.slice(pin.indexOf("pub fn clothesline_land_transfer"), pin.indexOf("unsafe fn prepare_transfer"));
    expect(landing).toContain("MonitorFromPoint");
    expect(landing).toContain("GetMonitorInfoW");
    expect(landing).not.toContain("snapshot.work_area");
  });
  it("创建确认依赖真实窗口就绪，失败不得只返回线程已派发", () => {
    const pin = source("pinned_window.rs");
    expect(pin).toContain("create_clothesline_pin");
    expect(pin).toContain("recv_timeout");
    expect(pin).toContain("startup.sender.send");
  });
  it("原生模态拖动回传预览及松手，关闭按代际确认", () => {
    const pin = source("pinned_window.rs");
    expect(pin).toContain("WM_MOVING");
    expect(pin).toContain("WM_EXITSIZEMOVE");
    expect(pin).toContain("WM_CLOTHESLINE_CLOSE");
    expect(pin).toContain("state.generation == wparam.0 as u64");
  });
});
