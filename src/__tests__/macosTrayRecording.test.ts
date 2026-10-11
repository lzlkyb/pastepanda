import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const tray = readFileSync("src-tauri/src/tray_menu.rs", "utf8");
const supported = /#\[cfg\(any\(windows, target_os = "macos"\)\)\]/;

describe("原生托盘录屏不能在 Mac 上显示后静默丢弃", () => {
  it("录像区域变化必须使缓存菜单重新生成", () => {
    const key = tray.slice(tray.indexOf("fn snapshot_key"), tray.indexOf("fn store_recents"));
    expect(key).toContain("snap.rec_last");
  });
  it("上次录像区域在 Mac 上进入菜单快照", () => {
    const branch = tray.slice(tray.indexOf("fn collect_snapshot"), tray.indexOf("fn snapshot_key"));
    expect(branch).toMatch(supported);
    expect(branch).not.toMatch(/#\[cfg\(windows\)\]/);
  });
  it.each(["ID_RE_RECORD", "ID_SCREEN_REC"])("%s 路由接通 Windows 和 Mac 共用录屏模块", (id) => {
    const start = tray.indexOf(`} else if id == ${id} {`);
    expect(start).toBeGreaterThan(0);
    const branch = tray.slice(start, tray.indexOf("} else if id ==", start + 1));
    expect(branch).toMatch(supported);
    expect(branch).not.toMatch(/#\[cfg\(windows\)\]/);
  });
});
