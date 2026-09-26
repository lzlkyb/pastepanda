/**
 * rcDeviceTags 守卫测试（规则 11.1）：钉住「前端清洗」口径——
 * 若哪天有人新写一个渲染点绕过 tagColorOf/normalizeDeviceTags，这里先红。
 * 与 Rust 侧 `normalize_tags`（data_store/rc_device.rs）同口径双保险。
 */
import { describe, expect, it } from "vitest";
import {
  MAX_TAGS_PER_DEVICE,
  distinctTagsOf,
  normalizeDeviceTags,
  tagColorOf,
  tagSummaryOf,
} from "@/lib/rcDeviceTags";

describe("normalizeDeviceTags 保存前清洗", () => {
  it("trim 后丢空名，长名截到 12 字", () => {
    expect(normalizeDeviceTags([
      { name: "   ", color: "red" },
      { name: "  家里  ", color: "red" },
      { name: "一二三四五六七八九十甲乙丙", color: "blue" },
    ])).toEqual([
      { name: "家里", color: "red" },
      { name: "一二三四五六七八九十甲乙", color: "blue" },
    ]);
  });

  it("按名去重（截断后同名也算重）", () => {
    expect(normalizeDeviceTags([
      { name: "work", color: "red" },
      { name: " work ", color: "blue" },
    ])).toEqual([{ name: "work", color: "red" }]);
  });

  it(`上限 ${MAX_TAGS_PER_DEVICE} 个，多出的丢弃`, () => {
    const many = Array.from({ length: 9 }, (_, i) => ({ name: `t${i}`, color: "green" }));
    expect(normalizeDeviceTags(many)).toHaveLength(MAX_TAGS_PER_DEVICE);
  });

  it("色板外的键（自定义 hex / 脏数据）一律回落 blue", () => {
    expect(normalizeDeviceTags([{ name: "x", color: "#ff0000" }]))
      .toEqual([{ name: "x", color: "blue" }]);
  });
});

describe("tagColorOf 渲染取色", () => {
  it("白名单内原样、白名单外回落", () => {
    expect(tagColorOf({ name: "a", color: "violet" })).toBe("violet");
    expect(tagColorOf({ name: "a", color: "pink" })).toBe("blue");
  });
});

describe("distinctTagsOf / tagSummaryOf", () => {
  it("跨设备按名字去重，色取首次出现的取值", () => {
    expect(distinctTagsOf([
      { tags: [{ name: "家里", color: "green" }] },
      { tags: [{ name: "家里", color: "red" }, { name: "办公", color: "cyan" }] },
      {},
    ])).toEqual([
      { name: "家里", color: "green" },
      { name: "办公", color: "cyan" },
    ]);
  });

  it("无标签返回空串——悬停里不编「标签：」占位", () => {
    expect(tagSummaryOf(undefined)).toBe("");
    expect(tagSummaryOf([])).toBe("");
    expect(tagSummaryOf([{ name: "a", color: "red" }, { name: "b", color: "blue" }]))
      .toBe("标签：a、b");
  });
});
