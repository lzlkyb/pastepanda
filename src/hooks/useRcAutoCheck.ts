import { useEffect, useRef, useState } from "react";
import type { RcTargetDevice } from "@/lib/api/rc";
import { useWindowVisible } from "@/hooks/useWindowVisible";

const CHECK_INTERVAL_MS = 30_000;
const CHECK_BATCH_SIZE = 2;

/** 只在工作台可见时刷新设备并分批确认。短连接的结果留在 rcStore，不改历史在线时间。 */
export function useRcAutoCheck({
  enabled,
  channelUp,
  refreshTargets,
  probeTargets,
}: {
  enabled: boolean;
  channelUp: boolean;
  refreshTargets: () => Promise<RcTargetDevice[] | null>;
  probeTargets: (ids: string[]) => Promise<void>;
}) {
  // Tauri 窗口初次读取可见性之前不拨号；浏览器预览会在 hook 内恢复为可见。
  const visible = useWindowVisible(false);
  const [refreshKey, setRefreshKey] = useState(0);
  // 🔴 在途轮次（2026-09-23 审计修）：channelUp 翻转在依赖里，会把本 effect
  // 整个重启——上一轮的 refreshTargets+probe 还在飞时又起一轮，两串并发在飞，
  // 与手动「重新检查」（refreshKey）撞上就是三份。新 effect 见到在途轮次不再
  // 另起一串，挂上去等它收尾后重新排定时；cancelled 守卫语义保持不变。
  const inflight = useRef<Promise<void> | null>(null);

  useEffect(() => {
    if (!enabled || !visible) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const schedule = () => {
      if (!cancelled && !timer) timer = setTimeout(() => void start(), CHECK_INTERVAL_MS);
    };
    const round = async () => {
      const targets = await refreshTargets();
      if (cancelled) return;
      if (channelUp && targets) {
        const ids = targets.filter((target) => target.source === "rc").map((target) => target.node_id);
        for (let i = 0; i < ids.length; i += CHECK_BATCH_SIZE) {
          if (cancelled) return;
          await probeTargets(ids.slice(i, i + CHECK_BATCH_SIZE));
        }
      }
      schedule();
    };
    function start() {
      if (cancelled) return;
      if (inflight.current) {
        // 有轮次在飞：只等它结束再排下一次定时，不重复触发整轮。
        void inflight.current.then(schedule);
        return;
      }
      const p = round().finally(() => {
        if (inflight.current === p) inflight.current = null;
      });
      inflight.current = p;
    }
    start();
    return () => {
      cancelled = true;
      if (timer) clearTimeout(timer);
    };
  }, [enabled, visible, channelUp, refreshTargets, probeTargets, refreshKey]);

  return () => setRefreshKey((key) => key + 1);
}
