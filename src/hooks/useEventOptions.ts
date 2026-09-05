/**
 * hooks/useEventOptions.ts —— 顶栏「事件」下拉的选项（G3）。
 *
 * # 为什么自己拉而不用内存里的 history
 *
 * `SourceFilterDropdown` 的选项是从内存 `history` 算的，但那一招在这里不行：
 * 初始只加载 **50 条**，靠滚动分页长——刚启动时根本分不出几个事件，
 * 而「想起上周三那阵」正是本功能的主场景。所以另走一条只查五列的轻查询。
 *
 * # 懒加载
 *
 * 只在下拉展开时拉：挂 mount 上会白白多一次启动查询（大多数人不会点它），
 * 而挂 `historyVersion` 上则每复制一条就重拉。
 */
import { useCallback, useState } from "react";
import { historyRecentMeta } from "@/lib/api/dailyBrief";
import { segmentByGap, EVENT_GAP_SECS } from "@/lib/events";
import { eventLabel, eventRangeValue } from "@/lib/eventLabel";

/**
 * 一段至少要有几条才算「一件事」。
 *
 * 设计稿：真实数据 41 段里有不少是 1 条的，一条孤零的复制不是「一件事」，
 * 列出来只会把下拉凑成垃圾。
 */
export const MIN_EVENT_ITEMS = 2;

export interface EventOption {
  key: string;
  label: string;
}

/** 固定的首项。 */
const ALL: EventOption = { key: "all", label: "全部" };

export function useEventOptions() {
  const [options, setOptions] = useState<EventOption[]>([ALL]);

  const load = useCallback(() => {
    void historyRecentMeta().then((rows) => {
      const segs = segmentByGap(rows, EVENT_GAP_SECS)
        .filter((s) => s.items.length >= MIN_EVENT_ITEMS)
        // 最新的在前：找东西总是从最近找起；分段本身是升序的，所以翻一下
        .reverse();
      // 取一次「现在」给全部标签用：逐条取的话，跨午夜那一瞬会出现
      // 前几条算「今天」后几条算「昨天」的不一致。
      const now = new Date();
      setOptions([
        ALL,
        ...segs.map((s) => ({ key: eventRangeValue(s), label: eventLabel(s, now) })),
      ]);
    });
  }, []);

  return { options, load };
}
