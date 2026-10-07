import { describe, expect, it } from "vitest";
import { snapTrimRange } from "./trimSnap";

describe("snapTrimRange（宁多勿少，与后端 rec/trim.rs snap 同规则）", () => {
  const kf = [0, 330, 660];

  it("入点向下吸、出点向上吸", () => {
    expect(snapTrimRange(kf, 990, 100, 500)).toEqual({ inMs: 0, outMs: 660 });
    expect(snapTrimRange(kf, 990, 330, 660)).toEqual({ inMs: 330, outMs: 660 });
  });

  it("出点后无关键帧吸到末尾；越界钳到时长", () => {
    expect(snapTrimRange(kf, 990, 700, 900)).toEqual({ inMs: 660, outMs: 990 });
    expect(snapTrimRange(kf, 990, 2000, 2500)).toEqual({ inMs: 660, outMs: 990 });
  });

  it("反向输入先归一，出点仍向上吸", () => {
    expect(snapTrimRange(kf, 990, 500, 100)).toEqual({ inMs: 0, outMs: 660 });
  });

  it("无关键帧原值返回（音频轨 / 全同步兜底）", () => {
    expect(snapTrimRange([], 990, 100, 500)).toEqual({ inMs: 100, outMs: 500 });
  });
});
