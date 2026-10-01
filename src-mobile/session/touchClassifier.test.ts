/**
 * touchClassifier 守卫单测 —— 手势判定是「点不准/误触」类事故的源头，
 * 每条用例钉住 design/远程电脑-手机端-触摸语义与坐标系-设计稿 §1/§2 的
 * 一条判定。时钟手动推进，不吃真实等待。
 */
import { describe, expect, it } from "vitest";
import { TouchClassifier, type ClassifierClock, type TouchCallbacks } from "./touchClassifier";
import { LONG_PRESS_MS, TAP_MAX_MS } from "./touchConstants";

/** 手动时钟：advance 逐档推进并触发到点任务（同刻多任务按加入序）。 */
function fakeClock() {
  let t = 0;
  let seq = 0;
  const tasks = new Map<number, { fn: () => void; at: number }>();
  const clock: ClassifierClock & { advance(ms: number): void } = {
    now: () => t,
    schedule: (fn, ms) => {
      const id = ++seq;
      tasks.set(id, { fn, at: t + ms });
      return id;
    },
    cancel: (id) => void tasks.delete(id as number),
    advance(ms) {
      t += ms;
      for (const [id, task] of [...tasks]) {
        if (task.at <= t) {
          tasks.delete(id);
          task.fn();
        }
      }
    },
  };
  return clock;
}

/** 回调记录器：各事件按序落袋，供断言。 */
function recorder() {
  const events: Array<{ ev: string; args: unknown[] }> = [];
  const push = (ev: string) => (...args: unknown[]) => void events.push({ ev, args });
  const cb: TouchCallbacks & { events: Array<{ ev: string; args: unknown[] }> } = {
    events,
    onTap: push("tap"),
    onMoveTo: push("move"),
    onCharge: push("charge"),
    onChargeCancel: push("chargeCancel"),
    onRightClick: push("rightClick"),
    onDragStart: push("dragStart"),
    onDragMove: push("dragMove"),
    onDragEnd: push("dragEnd"),
    onScrollDelta: push("scroll"),
    onPinchStart: push("pinchStart"),
    onPinchUpdate: push("pinchUpdate"),
  };
  return { cb, events };
}

const kinds = (events: Array<{ ev: string }>) => events.map((e) => e.ev);

describe("touchClassifier — 单指", () => {
  it("快速点按 = 左键单击（无充能）", () => {
    const clock = fakeClock();
    const { cb, events } = recorder();
    const c = new TouchClassifier(cb, clock);
    c.down(1, 100, 100);
    clock.advance(80);
    c.up(1, 103, 102);
    expect(kinds(events)).toEqual(["tap"]);
    expect(events[0].args).toEqual([103, 102, false]);
  });

  it("320ms 内两击 = 双击的第二击标记（远端事件仍是同格式单击）", () => {
    const clock = fakeClock();
    const { cb, events } = recorder();
    const c = new TouchClassifier(cb, clock);
    c.down(1, 100, 100);
    clock.advance(80);
    c.up(1, 100, 100);
    clock.advance(100);
    c.down(1, 104, 100);
    clock.advance(80);
    c.up(1, 104, 100);
    expect(kinds(events)).toEqual(["tap", "tap"]);
    expect(events[1].args).toEqual([104, 100, true]);
  });

  it("充能前拖动 = 纯移动（无任何按键事件）", () => {
    const clock = fakeClock();
    const { cb, events } = recorder();
    const c = new TouchClassifier(cb, clock);
    c.down(1, 100, 100);
    clock.advance(50);
    c.move(1, 140, 100); // 40px 越过阈值
    c.move(1, 180, 104);
    c.up(1, 180, 104);
    expect(kinds(events)).toEqual(["move", "move"]);
  });

  it(`长按 ${LONG_PRESS_MS}ms 充能 → 原位抬起 = 右键`, () => {
    const clock = fakeClock();
    const { cb, events } = recorder();
    const c = new TouchClassifier(cb, clock);
    c.down(1, 100, 100);
    clock.advance(LONG_PRESS_MS + 10);
    c.up(1, 100, 100);
    expect(kinds(events)).toEqual(["charge", "rightClick"]);
    expect(events[1].args).toEqual([100, 100]);
  });

  it("充能后移动 = 左键拖拽（down 起点 → move → up），不产生右键", () => {
    const clock = fakeClock();
    const { cb, events } = recorder();
    const c = new TouchClassifier(cb, clock);
    c.down(1, 100, 100);
    clock.advance(LONG_PRESS_MS + 10);
    c.move(1, 130, 100);
    c.move(1, 170, 110);
    c.up(1, 170, 110);
    expect(kinds(events)).toEqual(["charge", "dragStart", "dragMove", "dragMove", "dragEnd"]);
    expect(events[1].args).toEqual([100, 100]);
    expect(events[4].args).toEqual([170, 110]);
  });

  it(`按住 ${TAP_MAX_MS}-550ms 之间抬起且未动 = 无事件（防误触窗）`, () => {
    const clock = fakeClock();
    const { cb, events } = recorder();
    const c = new TouchClassifier(cb, clock);
    c.down(1, 100, 100);
    clock.advance(380);
    c.up(1, 100, 100);
    expect(events).toEqual([]);
  });

  it("超点按窗且超距的抬起 = 无事件", () => {
    const clock = fakeClock();
    const { cb, events } = recorder();
    const c = new TouchClassifier(cb, clock);
    c.down(1, 100, 100);
    clock.advance(300);
    c.move(1, 108, 100); // 8px：未达拖动阈值，但已超点按位移
    c.up(1, 108, 100);
    expect(events).toEqual([]);
  });
});

describe("touchClassifier — 双指", () => {
  it("平行拖动（间距不变）→ 滚动，且第二指落下后单指不再产生 tap", () => {
    const clock = fakeClock();
    const { cb, events } = recorder();
    const c = new TouchClassifier(cb, clock);
    c.down(1, 100, 300);
    clock.advance(100); // 充能点之前落下第二指（充能后冻结的用例在下方单测）
    c.down(2, 200, 300);
    clock.advance(100);
    // 平行下滑 40px（间距恒 100）
    c.move(1, 100, 320);
    c.move(2, 200, 320);
    c.move(1, 100, 340);
    c.move(2, 200, 340);
    c.up(1, 100, 340);
    c.up(2, 200, 340);
    expect(kinds(events).filter((e) => e === "scroll").length).toBeGreaterThan(0);
    expect(kinds(events)).not.toContain("tap");
    expect(kinds(events)).not.toContain("charge");
    expect(kinds(events)).not.toContain("pinchStart");
  });

  it("双指张开 → 捏合（ratio 相对起点），无滚动事件", () => {
    const clock = fakeClock();
    const { cb, events } = recorder();
    const c = new TouchClassifier(cb, clock);
    c.down(1, 100, 300);
    c.down(2, 200, 300); // 起始间距 100
    clock.advance(50);
    c.move(1, 60, 300);
    c.move(2, 240, 300); // 间距 180：Δ间距 80 >> Δ中点 0
    c.move(1, 40, 300);
    c.move(2, 260, 300); // 间距 220
    c.up(1, 40, 300);
    c.up(2, 260, 300);
    // 分类帧本身也带一次 update（间距 100→140 的变化不能丢，否则缩放首帧跳变）
    expect(kinds(events)).toEqual([
      "pinchStart",
      "pinchUpdate",
      "pinchUpdate",
      "pinchUpdate",
      "pinchUpdate",
    ]);
    expect(events[1].args[0]).toBeCloseTo(1.4, 5);
    expect(events[2].args[0]).toBeCloseTo(1.8, 5);
    expect(events[4].args[0]).toBeCloseTo(2.2, 5);
  });

  it("左键拖拽进行中第二指被忽略：拖拽不冻结、不卡键", () => {
    const clock = fakeClock();
    const { cb, events } = recorder();
    const c = new TouchClassifier(cb, clock);
    c.down(1, 100, 100);
    clock.advance(LONG_PRESS_MS + 10);
    c.move(1, 140, 100); // 进入拖拽
    c.down(2, 300, 300); // 拖拽中第二指
    c.move(1, 180, 100); // 第一指继续拖
    c.up(2, 300, 300);
    c.up(1, 180, 100);
    expect(kinds(events)).toEqual([
      "charge",
      "dragStart",
      "dragMove",
      "dragMove",
      "dragEnd",
    ]);
  });

  it("双指轻触（无分类位移）抬起 = 零事件", () => {
    const clock = fakeClock();
    const { cb, events } = recorder();
    const c = new TouchClassifier(cb, clock);
    c.down(1, 100, 300);
    c.down(2, 200, 300);
    clock.advance(120);
    c.move(1, 101, 300);
    c.move(2, 200, 301); // 噪声地板以下
    c.up(1, 101, 300);
    c.up(2, 200, 301);
    expect(events).toEqual([]);
  });
});

describe("touchClassifier — 兜底", () => {
  it("cancelAll 取消充能且不再产生任何事件", () => {
    const clock = fakeClock();
    const { cb, events } = recorder();
    const c = new TouchClassifier(cb, clock);
    c.down(1, 100, 100);
    c.cancelAll();
    clock.advance(LONG_PRESS_MS + 50);
    c.up(1, 100, 100);
    expect(events).toEqual([]);
  });

  it("充能后第二指冻结 → chargeCancel 发出，原抬起不发右键", () => {
    const clock = fakeClock();
    const { cb, events } = recorder();
    const c = new TouchClassifier(cb, clock);
    c.down(1, 100, 100);
    clock.advance(LONG_PRESS_MS + 10); // charged
    c.down(2, 200, 200); // 冻结
    c.up(1, 100, 100);
    c.up(2, 200, 200);
    expect(kinds(events)).toEqual(["charge", "chargeCancel"]);
  });
});
