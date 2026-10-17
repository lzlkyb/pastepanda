import { readFileSync } from "node:fs";
import { it, expect } from "vitest";
const shot = readFileSync("src-tauri/src/screenshot.rs", "utf8");
it("相同截图重复采集仍广播图片结果，不能只有更新时间后静默返回", () => {
  const start = shot.indexOf('if let Ok(Some(existing)) = store.find_latest_by_md5(&img_hash, "默认", "image")');
  const branch = shot.slice(start, shot.indexOf("let item = crate::data_store::HistoryItem", start));
  expect(branch.includes("app.emit(") && branch.includes('"clipboard-changed"')).toBe(true);
});
it("预截屏与截屏API统一避开绳层，截图会话结束解除门控", () => {
  expect(shot.includes("let _clothesline_capture=crate::clothesline::CaptureGuard::new(&app)")).toBe(true);
  expect(shot.includes("crate::clothesline::set_suspended(app,true)")).toBe(true);
  expect(shot.includes("crate::clothesline::set_suspended(&app,false)")).toBe(true);
});
