import { describe, expect, it } from "vitest";
import { fsHintCopy, shouldShowFsHint } from "@/lib/rcFsHint";

const base = {
  fullscreen: false,
  dismissed: false,
  hasFrame: true,
  stageH: 280,
  contentW: 1920,
  contentH: 1080,
  displayW: 600,
  displayH: 338,
};

describe("shouldShowFsHint", () => {
  it("舞台偏矮时展示", () => {
    expect(shouldShowFsHint(base)).toBe(true);
  });
  it("全屏 / 已点知道了 / 无画面 不展示", () => {
    expect(shouldShowFsHint({ ...base, fullscreen: true })).toBe(false);
    expect(shouldShowFsHint({ ...base, dismissed: true })).toBe(false);
    expect(shouldShowFsHint({ ...base, hasFrame: false })).toBe(false);
  });
  it("舞台够高且显示边相对内容足够大时不展示", () => {
    expect(
      shouldShowFsHint({
        ...base,
        stageH: 480,
        displayW: 1600,
        displayH: 900,
      }),
    ).toBe(false);
  });
  it("显示宽度低于内容 55% 时展示（鼠标放大比）", () => {
    expect(
      shouldShowFsHint({
        ...base,
        stageH: 500,
        displayW: 1920 * 0.5,
        displayH: 200,
      }),
    ).toBe(true);
  });
  it("尚未量到 display 且舞台高度未知时不抢先展示", () => {
    expect(
      shouldShowFsHint({
        ...base,
        stageH: 0,
        displayW: 0,
        displayH: 0,
      }),
    ).toBe(false);
  });
  it("无内容尺寸不展示", () => {
    expect(shouldShowFsHint({ ...base, contentW: 0, contentH: 0 })).toBe(false);
  });
});

describe("fsHintCopy", () => {
  it("可控与只看文案不同且带全屏引导", () => {
    const c = fsHintCopy(true);
    const v = fsHintCopy(false);
    expect(c.title).toContain("鼠标");
    expect(v.title).not.toContain("鼠标");
    expect(c.sub).toContain("全屏");
    expect(v.sub).toContain("全屏");
  });
});
