import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

describe("启动与保存后的热键使用同一份配置解析", () => {
  it.each(["src-tauri/src/lib.rs", "src-tauri/src/commands/system.rs"])("%s 不重复定义默认键", (path) => {
    const source = readFileSync(path, "utf8");
    expect(source).toMatch(/HotkeyConfig::from_saved\(&[a-z_]+\)/);
    expect(source).not.toMatch(/\.get\("screenshot_hotkey"\)/);
  });
});
