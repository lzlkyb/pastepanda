import { describe, it, expect } from "vitest";
import { canSubmitPair } from "./rcPairState";

/**
 * 🔴 防死锁回归。
 *
 * 旧版死锁链条：完成按钮 → 依赖 `checked` → 依赖 preview 出的指纹 →
 * 指纹只能靠「能点的按钮」去 preview。三者互锁。
 *
 * 方案 C（2026-09-17）删掉了 `checked`，所以死锁结构上不可能回来；
 * 但**剩下这条判据仍然必须成立**：没有指纹时即便 code 非空也不可点——
 * 否则用户会点一个「点了也没用」的按钮（后端拿不到 node_id）。
 */
describe("canSubmitPair", () => {
  it("无指纹 + 非空 code → false（这就是原来那条死锁判据的位置）", () => {
    expect(canSubmitPair({ code: "abc123", previewFp: null, busy: false })).toBe(false);
  });

  it("code 为空 → false", () => {
    expect(canSubmitPair({ code: "", previewFp: "abcd", busy: false })).toBe(false);
  });

  it("code 纯空格 → false", () => {
    expect(canSubmitPair({ code: "   ", previewFp: "abcd", busy: false })).toBe(false);
  });

  it("三要件齐备且不忙 → true", () => {
    expect(canSubmitPair({ code: "abc123", previewFp: "abcd", busy: false })).toBe(true);
  });

  it("busy: true → false", () => {
    expect(canSubmitPair({ code: "abc123", previewFp: "abcd", busy: true })).toBe(false);
  });

  it("不再有「勾选」这一项：多传 checked 是类型错误", () => {
    // 方案 C 把发起侧的勾选删了。这条由 `tsc`（`npm run build` 的第一步）兜住：
    // 若哪天有人把 `checked` 加回 `PairSubmitState`，下面这行就**不再报错**，
    // 于是 `@ts-expect-error` 变成「无用指令」→ tsc 直接红。
    // vitest 只做类型剥离、不做检查，所以这条真正的守门人是 tsc。
    // @ts-expect-error 方案 C 之后 PairSubmitState 里没有 checked
    expect(canSubmitPair({ code: "abc123", previewFp: "abcd", busy: false, checked: true })).toBe(
      true
    );
  });
});
