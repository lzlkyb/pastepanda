/**
 * 文字标注折行（wrapLines）。
 *
 * 回归点：文字标注以前不折行，而合成画布就是选区大小 —— 超出选区右边界的
 * 那段字落字后直接被裁掉，而输入框里是完整的（内容丢失）。
 * 微信截图的行为是「碰到截图边界就自动换行」，这里同口径。
 *
 * jsdom 的 canvas.getContext("2d") 返回 null，所以全部用注入的宽度函数：
 * 汉字 10px / ASCII 5px（近似真实字体的全角半角比例）。
 */

import { describe, it, expect } from "vitest";
import { wrapLines } from "@/lib/screenshot/draw";

const fake = (s: string) =>
  [...s].reduce((w, ch) => w + (/[一-鿿＀-￯]/.test(ch) ? 10 : 5), 0);

const wrap = (text: string, maxW?: number) => wrapLines(text, 20, maxW, fake);

describe("wrapLines", () => {
  it("不传宽度 / 宽度非法时不折行，仅按硬换行拆", () => {
    expect(wrap("一二三\n四五")).toEqual(["一二三", "四五"]);
    expect(wrap("一二三", 0)).toEqual(["一二三"]);
    expect(wrap("一二三", Number.NaN)).toEqual(["一二三"]);
  });

  it("纯中文：逐字折（汉字等宽，与浏览器结果一致）", () => {
    expect(wrap("一二三四五六", 30)).toEqual(["一二三", "四五六"]);
  });

  it("恰好卡在边界：等于 maxW 不折，超过才折", () => {
    expect(wrap("一二三", 30)).toEqual(["一二三"]);
    expect(wrap("一二三", 29)).toEqual(["一二", "三"]);
  });

  it("硬换行优先，且空行保留占位（否则行数与输入框对不上）", () => {
    expect(wrap("一二三四\n\n五", 20)).toEqual(["一二", "三四", "", "五"]);
  });

  it("西文：在空格处断，不拆单词", () => {
    // "hello "=30, "world"=25；宽 40 装不下两词
    expect(wrap("hello world", 40)).toEqual(["hello ", "world"]);
  });

  it("单个单词就超宽（长 URL）：强制逐字拆，不死循环", () => {
    const out = wrap("abcdefghij", 20); // 每字 5px → 每行 4 字
    expect(out).toEqual(["abcd", "efgh", "ij"]);
  });

  it("中英混排：汉字可逐字断，英文词整体移行", () => {
    // "中文"=20 + "abc"=15 = 35 > 30 → abc 整个移下行
    expect(wrap("中文abc", 30)).toEqual(["中文", "abc"]);
  });

  it("空串返回单个空行（不能变成零行，否则高度估算会归零）", () => {
    expect(wrap("", 30)).toEqual([""]);
  });
});
