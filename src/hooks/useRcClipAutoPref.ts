/**
 * useRcClipAutoPref — 会话内「剪贴板自动同步」开关的偏好读写（B 方案，2026-09-25 拍板）。
 *
 * 从 `RcSessionView` 抽出的直接原因是行数红线（`.tsx ≤ 300`），但这块逻辑本来就自洽：
 * **默认开 + 记住关闭**，初值从 store 的 config 同步读（启动时 `lib/api/init` 已水合，
 * 会话挂载无时序问题；旧配置缺键 → 默认开，口径收口在 `rcClipAutoFromConfig`）。
 *
 * 落盘走「乐观写 store → 串行落盘 → 失败回滚」：
 * - 串行（`chainRef`）是因为快速连点会产生两条 `save_config`，不排队的话后写的
 *   可能先落盘，最终磁盘上是旧值；
 * - 回滚同时改 store 与本地 state——只回滚一个会出现「界面说关了、下次启动自己
 *   变回去」这种被当成存不住的怪 bug（对齐设置壳 `updateAndSave`）。
 *
 * 只看会话的双重门控不在这里（hook no-op + 按钮不渲染分别在 `useRcClipboardAuto`
 * 和 `RcCapsuleMore`），这里只管偏好本身。
 */
import { useCallback, useRef, useState } from "react";
import { rcClipAutoFromConfig } from "@/lib/rcClipAuto";
import { useAppStore } from "@/stores/appStore";
import type { ToastFn } from "@/components/Toast";

export function useRcClipAutoPref(toast: ToastFn) {
  const [clipAuto, setClipAuto] = useState(() =>
    rcClipAutoFromConfig(useAppStore.getState().config),
  );
  const updateConfig = useAppStore((s) => s.updateConfig);
  const chainRef = useRef(Promise.resolve() as Promise<unknown>);

  const toggleClipAuto = useCallback(() => {
    const next = !clipAuto;
    setClipAuto(next);
    updateConfig({ rc_clip_auto: next });
    const task = chainRef.current.then(async () => {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("save_config", { config: useAppStore.getState().config });
    });
    chainRef.current = task.catch(() => {});
    void task.catch(() => {
      updateConfig({ rc_clip_auto: !next });
      setClipAuto(!next);
      toast("剪贴板同步偏好保存失败，已还原", "error");
    });
  }, [clipAuto, toast, updateConfig]);

  return { clipAuto, toggleClipAuto };
}
