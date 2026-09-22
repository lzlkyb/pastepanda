/**
 * `frameApplyStart` 的守卫单测。
 *
 * 这组用例钉的是**安全边界**（能不能丢帧），不是实现细节：
 * - H.264/HEVC 的 P 帧引用链一断就是花屏 ⇒ 只要批里有非 JPEG 帧就必须全序；
 * - JPEG 脏块帧依赖前一张画布 ⇒ 不能单独丢，只能整块跳到整帧；
 * - 整帧在批首时不能跳（后面的脏块帧要靠它铺底）。
 */
import { describe, expect, it } from "vitest";
import { frameApplyStart } from "./rcFramePlan";
import type { RcBinFrame } from "./api/rcFrameTypes";

/** 造帧：`full=false` 且给了 rect = 脏块帧；`full=true` 或 rect 为空 = 整帧。 */
function frame(
  opts: { codec?: "jpeg" | "h264" | "hevc"; full?: boolean; rect?: boolean } = {},
): RcBinFrame {
  return {
    codec: opts.codec ?? "jpeg",
    key: false,
    full: opts.full ?? false,
    at_ms: 0,
    cap_ms: 0,
    enc_ms: 0,
    width: 1920,
    height: 1080,
    rect: (opts.rect ?? false) ? { x: 0, y: 0, w: 16, h: 16 } : null,
    data: new Uint8Array(0),
  };
}
const rect = () => frame({ rect: true });
const fullJpeg = () => frame({ full: true });

describe("frameApplyStart", () => {
  it("空批不跳", () => {
    expect(frameApplyStart([])).toBe(0);
  });

  it("全脏块帧不跳（丢了会花屏缺块）", () => {
    expect(frameApplyStart([rect(), rect(), rect()])).toBe(0);
  });

  it("批里有 H.264 ⇒ 整批全序，一帧都不丢", () => {
    const batch = [fullJpeg(), frame({ codec: "h264" }), fullJpeg()];
    expect(frameApplyStart(batch)).toBe(0);
  });

  it("批里有 HEVC ⇒ 同上", () => {
    expect(frameApplyStart([fullJpeg(), fullJpeg(), frame({ codec: "hevc" })])).toBe(0);
  });

  it("最后一个整帧在中间 ⇒ 跳到它，丢掉它之前的积压帧", () => {
    const batch = [rect(), rect(), fullJpeg(), rect(), rect()];
    expect(frameApplyStart(batch)).toBe(2);
  });

  it("末帧就是整帧 ⇒ 只画最后一帧", () => {
    expect(frameApplyStart([fullJpeg(), fullJpeg(), fullJpeg()])).toBe(2);
  });

  it("整帧在批首 ⇒ 不跳（其后的脏块帧要靠它铺底）", () => {
    expect(frameApplyStart([fullJpeg(), rect(), rect()])).toBe(0);
  });

  it("只有一帧整帧 ⇒ 不跳（下标 0 无意义）", () => {
    expect(frameApplyStart([fullJpeg()])).toBe(0);
  });

  it("「无 rect」与 full=true 同义，都算整帧", () => {
    const batch = [rect(), frame()]; // 第二帧 full=false 但 rect=null
    expect(frameApplyStart(batch)).toBe(1);
  });
});
