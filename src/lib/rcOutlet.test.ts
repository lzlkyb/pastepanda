/**
 * rcOutlet 守卫单测（甲-②，2026-09-29）。
 *
 * 钉的是三条会「悄悄退化」的判据（规则 11.1：口径收口后必须有守卫）：
 * 1. toast 语义 → 停留档的翻译表。退化表现是「失败 2s 自己走掉」或「成功永久钉在画面上」。
 * 2. 合并策略。退化表现是文件进度每 100ms 插一条，把别的结果全刷掉、队列位置每秒重排。
 * 3. 取头优先级。退化表现是一条 2s 就走的绿点把「重连失败」挤出画面。
 */
import { describe, expect, it } from "vitest";
import {
  OUTLET_INFO_MS,
  OUTLET_MAX,
  OUTLET_OK_MS,
  rcOutletHead,
  rcOutletKindOfToast,
  rcOutletMerge,
  rcOutletTtlOf,
  type RcOutletKind,
} from "./rcOutlet";

type Row = { id: number; kind: RcOutletKind; mergeKey?: string };
const row = (id: number, kind: RcOutletKind = "info", mergeKey?: string): Row => ({ id, kind, mergeKey });

describe("rcOutletKindOfToast", () => {
  it.each([
    ["success", "ok"],
    ["error", "bad"],
    ["warning", "bad"],
    ["info", "info"],
    ["loading", "info"],
    [undefined, "info"],
    ["乱写的值", "info"],
  ] as const)("toast %s → 出口 %s", (from, to) => {
    expect(rcOutletKindOfToast(from)).toBe(to);
  });

  it("未知值按 info（会说、6s 后自己走），绝不按 bad 永久钉住", () => {
    expect(rcOutletTtlOf(rcOutletKindOfToast("typo"))).toBe(OUTLET_INFO_MS);
  });
});

describe("rcOutletTtlOf", () => {
  it("只有成功短存（2s），信息 6s 与 useOkAutoClear 同口径", () => {
    expect(rcOutletTtlOf("ok")).toBe(OUTLET_OK_MS);
    expect(rcOutletTtlOf("info")).toBe(OUTLET_INFO_MS);
  });

  it("失败与进行中共驻——失败要给第二次看见的机会（规则 15.3）", () => {
    expect(rcOutletTtlOf("bad")).toBeUndefined();
    expect(rcOutletTtlOf("run")).toBeUndefined();
  });
});

describe("rcOutletMerge", () => {
  it("无 mergeKey：新的插最前", () => {
    expect(rcOutletMerge([row(1), row(2)], row(3)).map((e) => e.id)).toEqual([3, 1, 2]);
  });

  it("超过上限丢最旧（出口条只画一条，队列不该无限长）", () => {
    const prev = [row(1), row(2), row(3), row(4)];
    const out = rcOutletMerge(prev, row(5));
    expect(out.map((e) => e.id)).toEqual([5, 1, 2, 3]);
    expect(out).toHaveLength(OUTLET_MAX);
  });

  it("同 mergeKey：就地替换并**保留原位置**（进度不许把别的结果刷掉）", () => {
    const prev = [row(9, "info"), row(7, "run", "file"), row(5, "info")];
    const out = rcOutletMerge(prev, row(7, "run", "file"));
    expect(out.map((e) => e.id)).toEqual([9, 7, 5]);
  });

  it("同 mergeKey 但队里没有 → 按新条目插最前", () => {
    const out = rcOutletMerge([row(1)], row(2, "run", "file"));
    expect(out.map((e) => e.id)).toEqual([2, 1]);
  });

  it("返回新数组，不改原数组（zustand 靠引用变化通知）", () => {
    const prev = [row(1)];
    const out = rcOutletMerge(prev, row(2));
    expect(prev).toHaveLength(1);
    expect(out).not.toBe(prev);
  });
});

describe("rcOutletHead", () => {
  it("空队列不占位", () => {
    expect(rcOutletHead([])).toEqual({ head: null, rest: 0 });
  });

  it("bad > run > info > ok（绿点不许把失败挤出画面）", () => {
    const q = [row(1, "ok"), row(2, "info"), row(3, "run"), row(4, "bad")];
    expect(rcOutletHead(q).head!.id).toBe(4);
  });

  it("run 盖过 info/ok，但让给 bad", () => {
    expect(rcOutletHead([row(1, "ok"), row(2, "run"), row(3, "info")]).head!.id).toBe(2);
    expect(rcOutletHead([row(1, "run"), row(2, "bad")]).head!.id).toBe(2);
  });

  it("同档取先出现的那条 = 队列原有顺序（新的在前）", () => {
    expect(rcOutletHead([row(1, "bad"), row(2, "bad")]).head!.id).toBe(1);
  });

  it("计数 = 其余条数（只显示最新一条 + 计数）", () => {
    const r = rcOutletHead([row(1, "bad"), row(2), row(3)]);
    expect(r.head!.id).toBe(1);
    expect(r.rest).toBe(2);
  });
});
