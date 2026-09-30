/**
 * 乙-⑥（2026-09-30）：关键帧看门狗的回退链守卫。
 *
 * `useRcFrames.ts` 跑在 WebCodecs + Tauri 事件上，jsdom 里起不来，所以这条守卫
 * 只钉「回退链两档不许同码」这个形状——它曾经就是同码的（两个分支都 forceJpeg，
 * HEVC 直接跳过 H.264 砸 JPEG），而这类「写了 if 却没差别」的分支 tsc 和真机都
 * 抓不到，只能靠一条读源码的断言拦。即时失败路径（`:266`）一直是对的，这里是抄它。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const src = readFileSync(join(__dirname, "../hooks/useRcFrames.ts"), "utf8");

describe("关键帧看门狗回退链（>3s 没等到关键帧）", () => {
  it("HEVC/AV1 先退 H.264，H.264 才砸 JPEG——两档不许写成同一个调用", () => {
    const m = src.match(/Date\.now\(\) - waitingSinceMs > 3000\s*\)\s*\{([^}]*)\}/);
    expect(m).not.toBeNull();
    const body = m![1];
    expect(body).toContain("forceJpeg()");
    expect(body).toContain("forceH264()");
  });

  it("等关键帧期间每 500ms 重提 request_key（UDP 语义的喊话，单次丢不得）", () => {
    expect(src).toMatch(/lastKeyReqMs >= 500/);
  });
});
