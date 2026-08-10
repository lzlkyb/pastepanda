import { describe, it, expect } from "vitest";
import { jsonFormatTransform } from "@/lib/transforms/jsonFormatTransform";
import type { TransformContext } from "@/lib/transforms/types";

function ctx(text: string): TransformContext {
  return { text, contentType: "text" };
}

describe("jsonFormatTransform", () => {
  it("合法 JSON 缩进美化", async () => {
    const r = await jsonFormatTransform.run('{"a":1,"b":[1,2]}', {});
    expect(r.ok).toBe(true);
    expect(r.output).toContain("\n  \"a\"");
  });

  it("非法 JSON 明确报错", async () => {
    const r = await jsonFormatTransform.run("这不是 JSON", {});
    expect(r.ok).toBe(false);
    expect(r.message).toContain("JSON");
  });

  it("detect：像 JSON 才高分，普通文本为 0", () => {
    expect(jsonFormatTransform.detect(ctx('{"a":1}'))).toBeGreaterThan(0);
    expect(jsonFormatTransform.detect(ctx("[1,2,3]"))).toBeGreaterThan(0);
    expect(jsonFormatTransform.detect(ctx("普通文本"))).toBe(0);
  });

  it("数组 JSON 也能格式化", async () => {
    const r = await jsonFormatTransform.run("[1,2,3]", {});
    expect(r.ok).toBe(true);
    expect(r.output).toContain("\n");
  });
});
