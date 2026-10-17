import { useCallback, useSyncExternalStore } from "react";
import { invoke } from "@tauri-apps/api/core";
import { emit } from "@tauri-apps/api/event";
import { useAppStore } from "@/stores/appStore";
import { useToast } from "@/components/Toast";
import { logger } from "@/lib/logger";
import { applyTheme, type ThemeKey } from "@/lib/theme";

export type SettingsSaveState = "idle" | "pending" | "saved" | "error";

function notifyAppearance(partial: Record<string, unknown>) {
  if ("theme" in partial) {
    const theme = useAppStore.getState().config.theme;
    applyTheme(theme as ThemeKey);
    void emit("theme-changed", { theme }).catch(() => {});
  }
  if ("window_animation" in partial) {
    void emit("interface-motion-changed", useAppStore.getState().config.window_animation).catch(() => {});
  }
}

// Settings is conditionally mounted. IO ordering and key ownership belong to
// the WebView, so closing/reopening the page cannot restart a competing queue.
let saveQueue: Promise<unknown> = Promise.resolve();
let nextSaveId = 0;
const keyVersions = new Map<string, number>();
let pendingSaves = 0;
let persistedConfig: Record<string, unknown> = {};
let saveState: SettingsSaveState = "idle";
let failed: Record<string, unknown> | null = null;
const listeners = new Set<() => void>();
const subscribe = (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; };
const getSnapshot = () => saveState;
const report = (state: SettingsSaveState) => { saveState = state; listeners.forEach(listener => listener()); };

/** Serial writes, optimistic controls, and a visible result share one lifetime. */
export function useSettingsSave() {
  const { toast } = useToast();
  const state = useSyncExternalStore(subscribe, getSnapshot);

  const updateAndSave = useCallback(async function save(partial: Record<string, unknown>) {
    const epoch = ++nextSaveId;
    const before = useAppStore.getState().config as unknown as Record<string, unknown>;
    // Start each burst from the loaded config; optimistic predecessors are not
    // rollback targets. Successful full writes advance this snapshot below.
    if (pendingSaves === 0) persistedConfig = before;
    pendingSaves++;
    Object.keys(partial).forEach(key => keyVersions.set(key, epoch));
    useAppStore.getState().updateConfig(partial);
    report("pending");
    notifyAppearance(partial);
    const task = saveQueue.then(async () => {
      const config = useAppStore.getState().config;
      await invoke("save_config", { config });
      persistedConfig = config as unknown as Record<string, unknown>;
    });
    saveQueue = task.catch(() => {});
    try {
      await task;
      if (epoch === nextSaveId) {
        failed = null;
        report("saved");
      }
      return true;
    } catch (error) {
      logger.warn("即时保存失败", error);
      // An old failure may revert only keys still owned by that request. Comparing
      // values alone fails when a quick on/off/on returns to the same value.
      const current = useAppStore.getState().config as unknown as Record<string, unknown>;
      const rollback = Object.fromEntries(Object.keys(partial)
        .filter(key => keyVersions.get(key) === epoch && Object.is(current[key], partial[key]))
        .map(key => [key, persistedConfig[key]]));
      useAppStore.getState().updateConfig(rollback);
      notifyAppearance(rollback);
      if (epoch === nextSaveId) {
        failed = partial;
        report("error");
      }
      if (Object.keys(rollback).length) {
        toast("设置保存失败，失败项已还原。", "error", undefined, () => void save(partial), "重新应用并保存");
      }
      return false;
    } finally {
      pendingSaves--;
    }
  }, [toast]);

  const retrySave = () => { if (failed) void updateAndSave(failed); };
  return { updateAndSave, saveState: state, retrySave };
}
