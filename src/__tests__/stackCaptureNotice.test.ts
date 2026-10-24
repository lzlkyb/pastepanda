/**
 * 🔴 批次②（通知治理 · 方案 A）—— 栈模式「复制入栈」提示的唯一决策守卫。
 *
 * 改前：栈模式下**每一次 Ctrl+C** 都弹「入栈 N 条」——全应用唯一"用户没在
 * 本应用里操作也弹"的高频被动通知。新口径（默认）：
 * - 常规入栈（含表格成功拆行）→ 零提示（浮标/横幅条数变化即反馈）；
 * - 异常（栈满没拆 / 只放进部分 / 像表格没拆开）→ 恒提示，不受开关控制；
 * - 开关 stack_capture_toast 打开后恢复常规文字确认。
 */
import { describe, it, expect } from "vitest";
import { resolveStackCaptureNotice } from "@/lib/stack/captureNotice";

const base = {
  stackMode: true,
  captureToastEnabled: false,
  tableSplitEnabled: true,
  split: null,
  grewBy: 1,
  unsplitTableLike: false,
  stackCap: 500,
};

describe("resolveStackCaptureNotice", () => {
  it("常规整条入栈：默认零提示（改前每次 Ctrl+C 都弹）", () => {
    expect(resolveStackCaptureNotice({ ...base })).toBeNull();
  });

  it("表格成功拆行：默认零提示", () => {
    expect(
      resolveStackCaptureNotice({ ...base, split: { totalRows: 5, splitCount: 5 } }),
    ).toBeNull();
  });

  it("开关打开后恢复常规文字确认", () => {
    expect(
      resolveStackCaptureNotice({ ...base, captureToastEnabled: true }),
    ).toBe("入栈 1 条");
    expect(
      resolveStackCaptureNotice({
        ...base,
        captureToastEnabled: true,
        split: { totalRows: 5, splitCount: 5 },
      }),
    ).toBe("已按行拆 5 条入栈");
  });

  it("异常恒提示，不受开关控制：栈满没拆", () => {
    const msg = resolveStackCaptureNotice({
      ...base,
      captureToastEnabled: false,
      split: { totalRows: 8, splitCount: 0 },
      grewBy: 0,
    });
    expect(msg).toContain("栈已满 500 条");
  });

  it("异常恒提示：表格只放进一部分", () => {
    const msg = resolveStackCaptureNotice({
      ...base,
      split: { totalRows: 30, splitCount: 20 },
      grewBy: 20,
    });
    expect(msg).toContain("只放进前 20 条");
  });

  it("异常恒提示：看着像表格但没拆开", () => {
    const msg = resolveStackCaptureNotice({ ...base, unsplitTableLike: true });
    expect(msg).toContain("没能按行拆开");
  });

  it("非栈模式不归它管", () => {
    expect(resolveStackCaptureNotice({ ...base, stackMode: false })).toBeNull();
  });
});
