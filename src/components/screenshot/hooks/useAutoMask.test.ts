import { describe, it, expect } from "vitest";
import { clusterWatermarkLines, editDistance } from "./useAutoMask";

describe("editDistance", () => {
  it("完全相同为 0", () => {
    expect(editDistance("长沙爱尔眼科医院", "长沙爱尔眼科医院")).toBe(0);
  });
  it("漏一字距离为 1", () => {
    expect(editDistance("长沙爱尔眼科医院", "长沙爱眼科医院")).toBe(1);
  });
  it("错一字距离为 1", () => {
    expect(editDistance("长沙爱尔眼科医院", "长沙爱耳眼科医院")).toBe(1);
  });
  it("长度差 >2 直接返回 >2（省开销）", () => {
    expect(editDistance("abc", "abcdefgh")).toBeGreaterThan(2);
  });
});

describe("clusterWatermarkLines（文字·自动去水印判定）", () => {
  it("理想重复水印：整串相同且出现 ≥2 次 → 全部识别", () => {
    // 模拟企业微信/钉钉斜向水印：同一行反复出现
    const lines = [
      "长沙爱尔眼科医院 2026-08-23",
      "普通聊天内容你好",
      "长沙爱尔眼科医院 2026-08-23",
      "另一段对话文字",
      "长沙爱尔眼科医院 2026-08-23",
    ];
    const flags = clusterWatermarkLines(lines);
    const wm = lines.filter((_, i) => flags[i]);
    expect(wm).toHaveLength(3);
    expect(wm.every((t) => t.includes("长沙爱尔"))).toBe(true);
  });

  it("PP-OCRv6 误差：漏空格/漏首字/错字 → 仍能聚类为一类并识别", () => {
    // 斜向半透明水印，PP-OCRv6 各行识别略有差异
    const lines = [
      "长沙爱尔眼科医院2026-08-23",
      "长沙爱尔眼科医院 2026-08-23", // 多空格
      "长沙爱耳眼科医院2026-08-23", // 错一字
      "长沙爱尔眼科医院2026-08-23",
      "这是一段普通聊天记录不会重复",
    ];
    const flags = clusterWatermarkLines(lines);
    // 前 4 行应被聚成同一水印类（编辑距离≤2 / 包含），第 5 行普通内容不误伤
    expect(flags[0]).toBe(true);
    expect(flags[1]).toBe(true);
    expect(flags[2]).toBe(true);
    expect(flags[3]).toBe(true);
    expect(flags[4]).toBe(false);
  });

  it("单行出现仅 1 次 → 不误判为水印", () => {
    const lines = [
      "长沙爱尔眼科医院2026-08-23", // 只出现一次
      "用户A：今天会议改到下午三点",
      "用户B：收到",
    ];
    const flags = clusterWatermarkLines(lines);
    expect(flags.every((f) => f === false)).toBe(true);
  });

  it("短串（<2 字）不计入，避免标点/单价误伤", () => {
    const lines = ["，", "。", "￥", "￥", "正常聊天内容"];
    const flags = clusterWatermarkLines(lines);
    // 单字符重复不应触发（minLen=2 过滤），且普通内容无重复
    expect(flags.every((f) => f === false)).toBe(true);
  });

  it("两行相近但仅出现 1 次不算水印（避免聊天里相似句子误伤）", () => {
    const lines = [
      "明天天气看起来不错适合出游",
      "后天天气看起来不错适合散步", // 编辑距离 >2 且不完全包含
      "用户说这句话一次",
    ];
    const flags = clusterWatermarkLines(lines);
    expect(flags.every((f) => f === false)).toBe(true);
  });
});
