/**
 * hooks/useAiStatus.ts —— v6.4 主窗口 AI 感知（方案 A）：TopBar 胶囊状态。
 *
 * **这里不再自己判定也不再自己缓存**（收口）：
 * 以前这个 hook 另写了一套两态判定（enabled && provider，没查密钥），
 * 与 aiTransforms 的 aiAvailable 标志并行存在两份缓存、两套结论，
 * 结果「已启用但没密钥」被胶囊说成「AI 就绪」。
 * 现在它只是 `@/lib/aiAvailability`（唯一判定 + 唯一缓存）的 React 订阅壳。
 *
 * 监听 `ai-config-changed` 事件（设置保存后 emit）即时刷新——配置完不用重启就生效。
 */
import { useEffect, useState } from "react";
import {
  ensureAiAvailabilityLoaded,
  getAiAvailability,
  refreshAiAvailability,
  subscribeAiAvailability,
  type AiAvailability,
  type AiAvailabilityState,
} from "@/lib/aiAvailability";

/** 三态（+ loading）定义在 aiAvailability 里，这里只做别名保留旧名字 */
export type AiStatus = AiAvailability;

export function useAiStatus(): AiAvailabilityState {
  const [snap, setSnap] = useState(getAiAvailability);

  useEffect(() => {
    const unsub = subscribeAiAvailability(() => setSnap(getAiAvailability()));
    // 订阅前可能已经有其他订阅者拉回了结果，补一次同步免得错过
    setSnap(getAiAvailability());
    ensureAiAvailabilityLoaded();
    let unlisten: (() => void) | null = null;
    let alive = true;
    import("@tauri-apps/api/event")
      .then(({ listen }) => listen("ai-config-changed", () => void refreshAiAvailability()))
      .then((fn) => {
        if (alive) unlisten = fn;
        else fn(); // 已卸载：监听器刚注册就得马上拆，不然永不释放
      })
      .catch(() => {});
    return () => {
      alive = false;
      unsub();
      unlisten?.();
    };
  }, []);

  return snap;
}

/** 供非 hook 场景（如事件回调）强制刷新 */
export function refreshAiStatus() {
  void refreshAiAvailability();
}
