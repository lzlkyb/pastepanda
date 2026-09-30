/**
 * 乙-③ 守卫：输入权交接的**前端判据**（规则 11.1 收口点）。
 *
 * 这四条各钉一个「写反了 UI 就骗人」的不变量：
 * 1. 「收回」与「锁定」的文案不许互换（它们动的是不同的人的手）；
 * 2. 对端状态缺失时「锁定对方」必须**不可点**（缺键 = 不许假设对方允许过）；
 * 3. pill 的 `idle` 一律不摆，脏值不许渲染成凭空多出来的指示；
 * 4. 琥珀提示只在 `host_hold` 为真时出现，且不写成「已断开」。
 */
import { describe, expect, it } from "vitest";
import {
  rcCaptureChipOf,
  rcGrantButtonOf,
  rcHoldButtonOf,
  rcHostHoldOutletOf,
  rcHostHoldPillOf,
  rcInputPillViews,
  rcLockButtonOf,
} from "./rcInputGate";
import type { RcPeerInputState } from "@/lib/api/rc";

const peer = (over: Partial<RcPeerInputState> = {}): RcPeerInputState => ({
  host_hold: false,
  lock_granted: false,
  lock_active: false,
  ...over,
});

describe("rcInputPillViews", () => {
  it("idle 一律不摆（缺值按 idle 处理）", () => {
    expect(rcInputPillViews(null)).toEqual([]);
    expect(rcInputPillViews(undefined)).toEqual([]);
    expect(rcInputPillViews({ keyboard: "idle", mouse: "idle" })).toEqual([]);
  });

  it("两枚各自独立，前缀与色档成对", () => {
    const v = rcInputPillViews({ keyboard: "peer", mouse: "blocked" });
    expect(v).toHaveLength(2);
    expect(v[0]).toMatchObject({ key: "keyboard", subject: "键盘", tone: "peer" });
    expect(v[1]).toMatchObject({
      key: "mouse",
      subject: "鼠标",
      phrase: "对方无权却被按下（已拦）",
      tone: "blocked",
    });
  });

  it("脏值（旧后端投影了个没定义的字面量）→ 不摆而不是崩", () => {
    // 判据只认三个有语义的档；其它值走 `?? "idle"` 那条分支的话会渲染成
    // 「undefined 在用」这种读不懂的 pill，所以这里显式收住。
    const dirty = { keyboard: "whatever", mouse: "local" } as unknown as {
      keyboard: "idle";
      mouse: "local";
    };
    const v = rcInputPillViews(dirty);
    expect(v.map((x) => x.key)).toEqual(["mouse"]);
  });
});

describe("rcLockButtonOf", () => {
  it("对端状态缺失 → 不可点（缺键不许当成「对方允许过」）", () => {
    expect(rcLockButtonOf(undefined).enabled).toBe(false);
    expect(rcLockButtonOf(null).enabled).toBe(false);
    expect(rcLockButtonOf(null).label).toBe("锁定对方");
  });

  it("未授权 → 不可点，且提示指向「让对方勾」而不是「功能不可用」", () => {
    const b = rcLockButtonOf(peer({ lock_granted: false }));
    expect(b.enabled).toBe(false);
    expect(b.tip).toContain("允许对方锁定我的输入");
  });

  it("已授权 → 可点；按钮语义随锁位翻转", () => {
    expect(rcLockButtonOf(peer({ lock_granted: true }))).toMatchObject({
      enabled: true,
      on: false,
      label: "锁定对方",
    });
    expect(rcLockButtonOf(peer({ lock_granted: true, lock_active: true }))).toMatchObject({
      enabled: true,
      on: true,
      label: "解除锁定",
    });
  });
});

describe("收回与锁定的文案不得互换", () => {
  it("收回按钮回显的是「我拿回来」，不是「锁住对方」", () => {
    expect(rcHoldButtonOf(false).label).toBe("暂时收回我的键鼠");
    expect(rcHoldButtonOf(true).label).toBe("归还键鼠给对方");
    // 缺值（旧后端）= 未收回，按钮仍写「收回」，不显示一个凭空的「归还」态
    expect(rcHoldButtonOf(undefined).label).toBe("暂时收回我的键鼠");
    expect(rcHoldButtonOf(true).tip).toContain("拦下");
  });

  it("授权位默认关，且说清「只到本场会话结束」", () => {
    expect(rcGrantButtonOf(undefined, undefined).label).toBe("允许对方锁定我的输入：关");
    expect(rcGrantButtonOf(true, false).label).toBe("允许对方锁定我的输入：开");
    expect(rcGrantButtonOf(true, true).tip).toContain("立刻解开");
    expect(rcGrantButtonOf(false, false).tip).toContain("默认关");
  });

  it("琥珀提示只跟着 host_hold，且不写成「已断开」", () => {
    expect(rcHostHoldPillOf(undefined)).toBeNull();
    expect(rcHostHoldPillOf(peer())).toBeNull();
    expect(rcHostHoldPillOf(peer({ host_hold: true }))).toBe("主机取回键鼠");
    const out = rcHostHoldOutletOf(peer({ host_hold: true }));
    expect(out?.label).toBe("主机正在自己操作");
    expect(out?.detail).toContain("10 分钟");
    // 谎话检查：被拦的只有键鼠，画面没断
    expect(JSON.stringify(out)).not.toContain("断开");
  });
});

describe("乙-④ 捕获态芯片（Esc 之外的鼠标出口）", () => {
  it("指针锁与键盘同时为真时只谈指针锁——锁着时光标根本点不到第二枚", () => {
    const chip = rcCaptureChipOf({ canControl: true, pointerLocked: true, kbOn: true });
    expect(chip?.action).toBe("pointer");
    expect(chip?.label).toBe("指针锁定中");
  });

  it("只有键盘捕获时给键盘档，且把「Esc 同效」写进提示", () => {
    const chip = rcCaptureChipOf({ canControl: true, pointerLocked: false, kbOn: true });
    expect(chip?.action).toBe("keyboard");
    expect(chip?.label).toBe("键盘捕获中");
    expect(chip?.tip).toContain("Esc 同效");
  });

  it("什么都没捕获 → null；只看档也 → null（它没有捕获能力，摆出来就是说谎）", () => {
    expect(rcCaptureChipOf({ canControl: true, pointerLocked: false, kbOn: false })).toBeNull();
    expect(rcCaptureChipOf({ canControl: false, pointerLocked: true, kbOn: true })).toBeNull();
  });
});
