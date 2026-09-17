import { describe, it, expect } from "vitest";
import { joinLinesTransform } from "@/lib/transforms/joinLines";
import type { TransformContext } from "@/lib/transforms/types";

function ctx(text: string): TransformContext {
  return { text, contentType: "text" };
}

/** 用户的原始需求样例：8 行 YH 单号 → 一行逗号（无空格）分隔 */
const SAMPLE = [
  "YH2026090200541896",
  "YH2026090200541898",
  "YH2026090200541900",
  "YH2026090200541905",
  "YH2026090200541908",
  "YH2026090200541913",
  "YH2026090200541914",
  "YH2026090800542353",
].join("\n");

describe("joinLinesTransform", () => {
  it("用户样例：默认逗号无空格，逐字符一致", async () => {
    const r = await joinLinesTransform.run(SAMPLE, {});
    expect(r.ok).toBe(true);
    expect(r.output).toBe(SAMPLE.split("\n").join(","));
    expect(r.meta?.count).toBe(8);
  });

  it("分隔符选项：带空格 / 分号 / 竖线 / 顿号", async () => {
    const t = ["a", "b", "c"].join("\n");
    expect((await joinLinesTransform.run(t, { sep: ", " })).output).toBe("a, b, c");
    expect((await joinLinesTransform.run(t, { sep: ";" })).output).toBe("a;b;c");
    expect((await joinLinesTransform.run(t, { sep: "|" })).output).toBe("a|b|c");
    expect((await joinLinesTransform.run(t, { sep: "、" })).output).toBe("a、b、c");
  });

  it("去重保留首次出现顺序", async () => {
    const r = await joinLinesTransform.run("b\na\nb\nc\na", { dedupe: "on" });
    expect(r.output).toBe("b,a,c");
  });

  it("排序：升序 / 降序（先去重再排）", async () => {
    expect((await joinLinesTransform.run("b\na\nb", { dedupe: "on", sort: "asc" })).output).toBe("a,b");
    expect((await joinLinesTransform.run("b\na\nb", { dedupe: "on", sort: "desc" })).output).toBe("b,a");
  });

  it("每行 trim、丢弃空行、兼容 CRLF", async () => {
    const r = await joinLinesTransform.run("  a  \r\n\r\nb\r\n", {});
    expect(r.output).toBe("a,b");
  });

  it("全空行明确报错", async () => {
    const r = await joinLinesTransform.run("\n \n", {});
    expect(r.ok).toBe(false);
    expect(r.message).toContain("没有可合并");
  });

  it("detect：竖列 ID 高分进推荐区，值越多分越高", () => {
    expect(joinLinesTransform.detect(ctx(SAMPLE))).toBeCloseTo(0.76, 5);
    const two = joinLinesTransform.detect(ctx("a\nb"));
    const ten = joinLinesTransform.detect(ctx(Array.from({ length: 10 }, (_, i) => `v${i}`).join("\n")));
    expect(two).toBeGreaterThan(0.6);
    expect(ten).toBeGreaterThan(two);
    expect(ten).toBeLessThanOrEqual(0.86);
  });

  it("detect：单行 / 空文本不适用", () => {
    expect(joinLinesTransform.detect(ctx("YH2026090200541896"))).toBe(0);
    expect(joinLinesTransform.detect(ctx("   "))).toBe(0);
  });

  it("detect：短中文名单进推荐区，长中文段落沉到 0.3", () => {
    // 短中文行（≤10 字，姓名/短语名单）是真实合并需求 → 照常打分
    expect(joinLinesTransform.detect(ctx("张三\n李四\n王五"))).toBeGreaterThan(0.6);
    // 长中文行过半 → 段落，不打扰推荐区
    expect(
      joinLinesTransform.detect(
        ctx("这是一段比较长的中文说明文字内容需要被识别出来\n第二段也是比较长的中文说明文字内容\n第三段同样较长"),
      ),
    ).toBe(0.3);
  });

  it("detect：普通英文多行段落（含双空格）为 0.3", () => {
    expect(joinLinesTransform.detect(ctx("hello   world\nfoo   bar"))).toBe(0.3);
  });
});
