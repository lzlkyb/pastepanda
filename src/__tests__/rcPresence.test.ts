/**
 * 设备可达性文案（多档，与后端 RcPresence 同构）。
 */
import { describe, it, expect } from "vitest";
import {
  presenceMainLabel,
  presenceHint,
  presenceDotClass,
} from "@/lib/rcDevice";

describe("presenceMainLabel", () => {
  it("live → 在线", () => {
    expect(presenceMainLabel("live", "刚刚")).toBe("在线");
  });
  it("recent → 带相对时间的「还在」", () => {
    expect(presenceMainLabel("recent", "1 分钟前")).toBe("1 分钟前还在");
    expect(presenceMainLabel("recent", "")).toBe("刚刚还在");
  });
  it("seen → 「见过」", () => {
    expect(presenceMainLabel("seen", "3 天前")).toBe("3 天前见过");
  });
  it("never → 明确说还没连上", () => {
    expect(presenceMainLabel("never", "")).toBe("配对后还没连上过");
  });
});

describe("presenceHint / dot", () => {
  it("live 是绿点 + 局域网可达", () => {
    expect(presenceDotClass("live")).toBe("dotOn");
    expect(presenceHint("live")).toContain("局域网");
  });
  it("recent 琥珀 + 仍可尝试", () => {
    expect(presenceDotClass("recent")).toBe("dotRecent");
    expect(presenceHint("recent")).toBe("仍可尝试");
  });
  it("seen/never 灰点", () => {
    expect(presenceDotClass("seen")).toBe("dotOff");
    expect(presenceDotClass("never")).toBe("dotOff");
    expect(presenceHint("seen")).toContain("中继");
    expect(presenceHint("never")).toContain("指纹");
  });
});
