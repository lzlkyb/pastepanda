/**
 * hooks/useAiStatus.ts —— v6.4 主窗口 AI 感知（方案 A）：TopBar 胶囊状态。
 *
 * **模块级单例**（审查 #6 修复）：App 与 AiStatusCap 共享同一份状态与一次后端拉取，
 * 不再各拉一遍 aiGetConfig + aiGetUsageStats；30s TTL 防高频刷新。
 * 监听 `ai-config-changed` 事件（设置保存后 emit）即时刷新——配置完不用重启就生效。
 */
import { useCallback, useEffect, useState } from "react";
import { aiGetConfig, aiGetUsageStats } from "@/lib/api";
import { logger } from "@/lib/logger";

export type AiStatus = "loading" | "off" | "on";

interface AiStatusState {
  status: AiStatus;
  weekCalls: number;
  model: string;
}

const TTL_MS = 30_000;

let state: AiStatusState = { status: "loading", weekCalls: 0, model: "" };
let loadedAt = 0;
let loading = false;
let loadPromise: Promise<void> | null = null;
const listeners = new Set<() => void>();

function notify() {
  listeners.forEach((l) => l());
}

async function doLoad(): Promise<void> {
  loading = true;
  try {
    const [cfg, stats] = await Promise.all([aiGetConfig(), aiGetUsageStats(7)]);
    const next: AiStatusState = cfg.enabled && cfg.provider.trim()
      ? { status: "on", weekCalls: stats?.totalCalls ?? 0, model: cfg.model.trim() || "已配置" }
      : { status: "off", weekCalls: 0, model: "" };
    // enabled=false 时 stats 也白拉了——属已知小开销，保持简单
    if (next.status !== state.status || next.weekCalls !== state.weekCalls) {
      state = next;
      notify();
    } else {
      state = next;
    }
    loadedAt = Date.now();
  } catch (e) {
    logger.warn("获取 AI 状态失败", e);
    if (state.status === "loading") {
      state = { status: "off", weekCalls: 0, model: "" };
      notify();
    }
  } finally {
    loading = false;
  }
}

/** 惰性加载：未加载或超 TTL 才拉；并发只拉一次 */
function ensureLoaded() {
  if (state.status !== "loading" && Date.now() - loadedAt < TTL_MS) return;
  if (loading) return;
  loadPromise = doLoad();
  loadPromise.catch(() => {});
}

export function useAiStatus(): AiStatusState {
  const [snap, setSnap] = useState(state);

  useEffect(() => {
    const sub = () => setSnap(state); // 订阅：通知时读最新模块态
    listeners.add(sub);
    ensureLoaded();
    let unlisten: (() => void) | null = null;
    // 设置里保存/测试成功后即时刷新（审查 #6：不用重启就能看到快捷区）
    import("@tauri-apps/api/event")
      .then(({ listen }) => listen("ai-config-changed", () => {
        loadedAt = 0;
        ensureLoaded();
      }))
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {});
    return () => {
      listeners.delete(sub);
      unlisten?.();
    };
  }, []);

  return snap;
}

/** 供非 hook 场景（如事件回调）强制刷新 */
export function refreshAiStatus() {
  loadedAt = 0;
  ensureLoaded();
}
