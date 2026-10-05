/**
 * touchClassifier 守卫单测 —— 手势判定是「点不准/误触」类事故的源头，
 * 每条用例钉住 design/远程电脑-手机端-触摸语义与坐标系-设计稿 §1/§2 的
 * 一条判定。时钟手动推进，不吃真实等待。
 */
import { describe, expect, it } from "vitest";
import { TouchClassifier, type ClassifierClock, type TouchCallbacks } from "./touchClassifier";
import { LONG_PRESS_MS } from "./touchConstants";

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

  it(`充能前（${LONG_PRESS_MS}ms 内）原位抬起 = 左键单击，无防误触死窗`, () => {
    // 2026-10-05 口径收口：220–550ms「无事件死窗」在接线（useSessionPointer
    // 传 550）上从未生效，点按窗与长按窗合一——充能前抬起都可能是一次点按。
    const clock = fakeClock();
    const { cb, events } = recorder();
    const c = new TouchClassifier(cb, clock);
    c.down(1, 100, 100);
    clock.advance(380);
    c.up(1, 100, 100);
    expect(kinds(events)).toEqual(["tap"]);
  });

  it("位移超阈值的抬起不是点按（转移动，抬起无点击）", () => {
    const clock = fakeClock();
    const { cb, events } = recorder();
    const c = new TouchClassifier(cb, clock);
    c.down(1, 100, 100);
    clock.advance(300);
    c.move(1, 120, 100); // 20px：超过 TAP_MAX_PX，转纯移动
    c.up(1, 120, 100);
    expect(kinds(events)).toEqual(["move"]);
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

  it("双指张开 → 捏合（ratio 相对上一帧），无滚动事件", () => {
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
    // 两指起手都到达后分类；等待期间累计的 100→180 间距变化不能丢。
    expect(kinds(events)).toEqual([
      "pinchStart",
      "pinchUpdate",
      "pinchUpdate",
      "pinchUpdate",
    ]);
    expect(events[1].args[0]).toBeCloseTo(1.8, 5);
    expect(events[2].args[0]).toBeCloseTo(200 / 180, 5);
    expect(events[3].args[0]).toBeCloseTo(220 / 200, 5);
    expect(events.slice(1).reduce((scale, e) => scale * Number(e.args[0]), 1)).toBeCloseTo(2.2, 5);
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

it("R2：静止 350ms 抬起仍是点击，不落入无反馈时间窗", () => {
  const clock = fakeClock(), { cb, events } = recorder();
  const c = new TouchClassifier(cb, clock, LONG_PRESS_MS);
  c.down(1, 50, 50); clock.advance(350); c.up(1, 50, 50);
  expect(kinds(events)).toEqual(["tap"]);
});

it("连续捏合按帧增量缩放，不重复乘起点比例", () => {
  const clock = fakeClock(), { cb, events } = recorder(); const c = new TouchClassifier(cb, clock);
  c.down(1, 0, 0); c.down(2, 100, 0);
  c.move(2, 130, 0); clock.advance(48); c.move(2, 150, 0);
  const updates = events.filter(e => e.ev === "pinchUpdate");
  expect(updates).toHaveLength(2);
  expect(Number(updates[0].args[0]) * Number(updates[1].args[0])).toBeCloseTo(1.5);
});

it("两指先后横向移动也识别滚动，第一指事件不提前锁成捏合", () => {
  const clock = fakeClock(), { cb, events } = recorder();
  const c = new TouchClassifier(cb, clock);
  c.down(1, 100, 100); c.down(2, 200, 100);
  c.move(1, 125, 100);
  expect(events).toEqual([]);
  c.move(2, 225, 100);
  expect(kinds(events)).toEqual(["scroll"]);
  expect(events[0].args.slice(0, 2)).toEqual([25, 0]);
});

it("慢速双指累计位移仍触发滚动，不丢起手距离", () => {
  const clock = fakeClock(), { cb, events } = recorder();
  const c = new TouchClassifier(cb, clock);
  c.down(1, 100, 100); c.down(2, 200, 100);
  for (let d = 1; d <= 15; d++) { c.move(1, 100, 100 + d); c.move(2, 200, 100 + d); }
  expect(kinds(events)).not.toContain("pinchStart");
  expect(events.reduce((total, e) => total + Number(e.args[1]), 0)).toBe(15);
});

it("双指起手等待中抬指取消定时识别，不产生迟到的缩放或单击", () => {
  const clock = fakeClock(), { cb, events } = recorder();
  const c = new TouchClassifier(cb, clock);
  c.down(1, 0, 0); c.down(2, 100, 0); c.move(2, 130, 0);
  c.up(2, 130, 0); clock.advance(100); c.up(1, 0, 0);
  expect(events).toEqual([]);
});

it("充能后取消清除预告，重开手势不会沿用双击状态", () => {
  const clock = fakeClock(), { cb, events } = recorder();
  const c = new TouchClassifier(cb, clock);
  c.down(1, 100, 100); clock.advance(550); c.cancelAll();
  expect(kinds(events)).toEqual(["charge", "chargeCancel"]);
  c.down(1, 100, 100); clock.advance(30); c.up(1, 100, 100);
  expect(events[events.length - 1]?.args[2]).toBe(false);
});

it("充能后在阈值外抬起且未收到移动事件，也清除预告", () => {
  const clock = fakeClock(), { cb, events } = recorder();
  const c = new TouchClassifier(cb, clock);
  c.down(1, 100, 100); clock.advance(550); c.up(1, 120, 100);
  expect(kinds(events)).toEqual(["charge", "chargeCancel"]);
});
