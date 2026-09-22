/**
 * useRcHistory — 会话历史元数据（挂载拉一次，可手动 reload）。
 *
 * 提到工作台层级的原因：详情面「最近会话」、侧栏「按设备筛选」、历史页列表
 * 三处都要这份数据，各自 `useEffect` 拉一次会打出三个请求，而且计数可能来自
 * 不同批快照——「全部设备 12 条」与各设备之和就会对不上。
 *
 * 主窗设置页那份仍由 `RcSessionHistory` 自拉：它在另一个窗口，不共享这份状态。
 */
import { useCallback, useEffect, useState } from "react";
import { rcSessionHistory, type RcHistoryItem } from "@/lib/api/rc";

export interface RcHistoryData {
  list: RcHistoryItem[];
  loading: boolean;
  err: string | null;
}

export interface UseRcHistory extends RcHistoryData {
  reload: () => Promise<void>;
}

export function useRcHistory(): UseRcHistory {
  const [state, setState] = useState<RcHistoryData>({ list: [], loading: true, err: null });

  const reload = useCallback(async () => {
    try {
      const list = await rcSessionHistory();
      setState({ list, loading: false, err: null });
    } catch (e) {
      setState({ list: [], loading: false, err: String(e) });
    }
  }, []);

  useEffect(() => {
    void reload();
  }, [reload]);

  return { ...state, reload };
}
