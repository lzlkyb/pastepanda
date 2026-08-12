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
  ensureAiConfigListener,
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
    // 审查：事件监听在 aiAvailability 模块级注册一次，这里不再各自 listen
    ensureAiConfigListener();
    return () => {
      unsub();
    };
  }, []);

  return snap;
}

/** 供非 hook 场景（如事件回调）强制刷新 */
export function refreshAiStatus() {
  void refreshAiAvailability();
}
