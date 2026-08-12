/**
 * confirm.test.ts —— 统一确认弹窗的 promise 语义。
 *
 * 重点钉住“并发时不丢 resolve”：旧实现直赋 `current`，前一个请求的 resolve
 * 会丢掉，那个 await 永远不返回——这种“流程静默停住”很难从 UI 上看出来。
 */
import { describe, it, expect, afterEach } from "vitest";
import { confirmDialog, getConfirm, resolveConfirm, subscribeConfirm } from "@/lib/confirm";

afterEach(() => {
  // 清干全局态，避免用例间串扰
  resolveConfirm(false);
});

describe("confirmDialog", () => {
  it("确认 → true，取消 → false", async () => {
    const p1 = confirmDialog({ title: "t", message: "m" });
    expect(getConfirm()?.title).toBe("t");
    resolveConfirm(true);
    expect(await p1).toBe(true);
    expect(getConfirm()).toBeNull();

    const p2 = confirmDialog({ title: "t2", message: "m2" });
    resolveConfirm(false);
    expect(await p2).toBe(false);
  });

  it("并发：第二个请求立即返回 false，**不覆盖**也不丢第一个", async () => {
    const first = confirmDialog({ title: "第一个", message: "m1" });
    const second = confirmDialog({ title: "第二个", message: "m2" });

    // 第二个不得顶掉屏幕上那个
    expect(getConfirm()?.title).toBe("第一个");
    expect(await second).toBe(false);

    // 第一个仍能正常 resolve（旧实现下这里会挂死）
    resolveConfirm(true);
    expect(await first).toBe(true);
  });

  it("订阅者在请求与解决时都被通知，取消订阅后不再收到", async () => {
    let n = 0;
    const off = subscribeConfirm(() => { n += 1; });
    const p = confirmDialog({ title: "t", message: "m" });
    expect(n).toBe(1);
    resolveConfirm(true);
    await p;
    expect(n).toBe(2);
    off();
    const p2 = confirmDialog({ title: "t", message: "m" });
    resolveConfirm(true);
    await p2;
    expect(n).toBe(2);
  });

  it("无待决请求时 resolveConfirm 是空操作，不报错", () => {
    expect(() => resolveConfirm(true)).not.toThrow();
    expect(getConfirm()).toBeNull();
  });
});
