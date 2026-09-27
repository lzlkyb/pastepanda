import { describe, expect, it } from "vitest";
import { shortCodeFromClipboard, shortCodeFromInput } from "./rcShortCode";

describe("短配对码识别", () => {
  it("剪贴板只自动识别带前缀的完整码", () => {
    expect(shortCodeFromClipboard("PP-0012-3456")).toBe("00123456");
    expect(shortCodeFromClipboard("00123456")).toBeNull();
    expect(shortCodeFromClipboard("订单号 PP-0012-3456")).toBeNull();
  });

  it("手动输入允许空格和分组横线，但必须恰好八位", () => {
    expect(shortCodeFromInput("0012 3456")).toBe("00123456");
    expect(shortCodeFromInput("0012-3456")).toBe("00123456");
    expect(shortCodeFromInput("PP-0012-3456")).toBe("00123456");
    expect(shortCodeFromInput("1234567")).toBeNull();
  });
});
