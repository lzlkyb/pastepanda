/**
 * 时间断段纯函数的用例。
 *
 * 它同时喂**每日整理（H3）**与**事件聚合（G3）**两个功能，
 * 所以边界必须写死——两边各自理解一遍就会漂。
 *
 * 阈值 1200 秒不是拍的：《事件聚合设计稿》在 540 条真实数据上扫过
 * 5/10/15/20/30/60 分钟，20 分钟是「调一个接口用了几段」的粒度。
 */
import { describe, it, expect } from "vitest";
import { segmentByGap, EVENT_GAP_SECS, type SegmentItem } from "@/lib/events";

/** 造一条元信息。`t` 是当天的 "HH:MM:SS"。 */
function it_(t: string, source = "Edge", type = "text"): SegmentItem {
  return { id: t, time: `2026-09-04 ${t}`, source, type, content_type: null };
}

describe("segmentByGap", () => {
  it("空输入 → 空段列表", () => {
    expect(segmentByGap([], EVENT_GAP_SECS)).toEqual([]);
  });

  it("间隔刚好等于阈值 → **不**断段（边界说死）", () => {
    // 09:00:00 与 09:20:00 相隔 1200 秒，恰好等于阈值
    const segs = segmentByGap([it_("09:00:00"), it_("09:20:00")], EVENT_GAP_SECS);
    expect(segs).toHaveLength(1);
    expect(segs[0].items).toHaveLength(2);
  });

  it("间隔超过阈值 1 秒 → 断成两段", () => {
    const segs = segmentByGap([it_("09:00:00"), it_("09:20:01")], EVENT_GAP_SECS);
    expect(segs).toHaveLength(2);
  });

  it("输入是降序时也能正确分段（列表接口返的就是降序）", () => {
    // 不先排序的话，降序输入算出来的相邻差是负数，会永远不断段。
    const segs = segmentByGap(
      [it_("11:00:00"), it_("10:59:00"), it_("09:00:00")],
      EVENT_GAP_SECS,
    );
    expect(segs).toHaveLength(2);
    expect(segs[0].startTime).toBe("09:00");
    expect(segs[1].items).toHaveLength(2);
  });

  it("段内按时间升序，段之间也按时间升序", () => {
    const segs = segmentByGap(
      [it_("14:00:00"), it_("09:00:00"), it_("14:05:00")],
      EVENT_GAP_SECS,
    );
    expect(segs.map((s) => s.startTime)).toEqual(["09:00", "14:00"]);
  });

  it("起止时间：单条段的 start 与 end 相同", () => {
    const segs = segmentByGap([it_("12:39:10")], EVENT_GAP_SECS);
    expect(segs[0].startTime).toBe("12:39");
    expect(segs[0].endTime).toBe("12:39");
  });

  it("主来源取段内出现最多的那个，并过 cleanSourceName 归一化", () => {
    // source 存的是完整窗口标题（真库实情），同一个 App 的不同窗口会是不同字串。
    // 不归一化的话，一段里同一个 App 会被当成好几个来源，主来源就选错了。
    const segs = segmentByGap(
      [
        it_("09:00:00", "a.java - Eclipse IDE"),
        it_("09:01:00", "b.java - Eclipse IDE"),
        it_("09:02:00", "企业微信"),
      ],
      EVENT_GAP_SECS,
    );
    expect(segs).toHaveLength(1);
    // 返的是真实应用名（窗口标题最后一段），不是映射表里的短名。
    // 要紧的是两个不同窗口归到了同一个名字上，主来源才数得对。
    expect(segs[0].topSource).toBe("Eclipse IDE");
  });

  it("类型计数按次数降序", () => {
    const segs = segmentByGap(
      [
        it_("09:00:00", "Edge", "image"),
        it_("09:01:00", "Edge", "text"),
        it_("09:02:00", "Edge", "text"),
      ],
      EVENT_GAP_SECS,
    );
    expect(segs[0].typeCounts).toEqual([
      { type: "text", count: 2 },
      { type: "image", count: 1 },
    ]);
  });

  it("空来源不能赢主来源——只要段里有带名字的就选带名字的", () => {
    // 真库实情（2026-09-05 最近 500 条）：7 条 `source` 为空，**全是截图**
    // （截图没有窗口标题）。`2026-08-30 20:55~20:58` 那段 3 条全是图片，
    // 2 条空 + 1 条有名字，多数决直接投出了空串，
    // 标签渲染成「8-30 20:55-20:58 ·  · 3 条」——中间空一格。
    const segs = segmentByGap(
      [
        it_("20:55:35", "", "image"),
        it_("20:56:00", "策手 StratHand", "image"),
        it_("20:58:12", "", "image"),
      ],
      EVENT_GAP_SECS,
    );
    expect(segs[0].topSource).toBe("策手 StratHand");
  });

  it("整段来源全空时，主来源回退成「未知来源」而不是空串", () => {
    // 标签位必须总有东西，否则分隔符会碍在一起。
    // 不在 `resolveSource` 里改空串的返值：那个函数有十几处调用方，
    // 来源芯片靠「空串就不渲染」这个行为，改了会让它们凭空多出一个标签。
    const segs = segmentByGap(
      [it_("20:55:35", "", "image"), it_("20:56:00", "", "image")],
      EVENT_GAP_SECS,
    );
    expect(segs[0].topSource).toBe("未知来源");
  });

  it("时间串解不出来的条目被丢掉，而不是把整段算崩", () => {
    // 数据脉里真出现过格式不一致的时间字串（带/不带毫秒）。
    // NaN 参与比较永远为 false，不过滤的话会静默地把整天揉成一段。
    const segs = segmentByGap(
      [
        { id: "bad", time: "不是时间", source: "Edge", type: "text", content_type: null },
        it_("09:00:00"),
        it_("14:00:00"),
      ],
      EVENT_GAP_SECS,
    );
    expect(segs).toHaveLength(2);
    expect(segs.flatMap((s) => s.items).some((i) => i.id === "bad")).toBe(false);
  });
});

describe("EVENT_GAP_SECS", () => {
  it("写死为 1200（实测定的，不开设置项）", () => {
    // 设计稿的理由：用户无法判断「20 分钟」对不对，
    // 把一个没人能回答的参数丢给用户不是灵活是推责。
    expect(EVENT_GAP_SECS).toBe(1200);
  });
});
