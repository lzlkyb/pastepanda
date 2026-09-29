/**
 * useRcHoverReveal — 顶缘 hover 唤出偏好的**读写**（乙档 2026-09-29，待拍板①）。
 *
 * 口径逐字对齐 `RcSessionView` 里 `rc_clip_auto` 的那套（同一条持久化链路）：
 * 乐观写 store → 串行 `save_config` 落盘（链内读最新快照，快速连点最后写的必是
 * 最新状态）→ 失败回滚屏与 store 并 toast。
 *
 * 🔴 失败必须出声（规则 15.3）：承载它的是收起态的浮条，一次「点了没存住」在
 * 静默状态下会被读成「这个开关是假的」；而偏好不回滚的话，下次启动自己变回
 * 「开」，正是剪贴板开关当初被当成 bug 的那个路径。
 *
 * 值本身从 `rcHoverRevealFromConfig` 读（缺键默认开），不在本地另存一份 state——
 * store 是唯一数据源，选择器返回派生布尔，会话内改档立刻生效。
 */
import { useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useToast } from "@/components/Toast";
import { useAppStore } from "@/stores/appStore";
import { rcHoverRevealFromConfig } from "@/lib/rcHoverReveal";

export function useRcHoverReveal() {
  const hoverReveal = useAppStore((s) => rcHoverRevealFromConfig(s.config));
  const updateConfig = useAppStore((s) => s.updateConfig);
  const { toast } = useToast();
  const chainRef = useRef(Promise.resolve() as Promise<unknown>);

  const toggleHoverReveal = useCallback(() => {
    const next = !rcHoverRevealFromConfig(useAppStore.getState().config);
    updateConfig({ rc_hover_reveal: next });
    const task = chainRef.current.then(async () => {
      await invoke("save_config", { config: useAppStore.getState().config });
    });
    chainRef.current = task.catch(() => {});
    void task.catch(() => {
      updateConfig({ rc_hover_reveal: !next });
      toast("浮条唤出偏好保存失败，已还原", "error");
    });
  }, [updateConfig, toast]);

  return { hoverReveal, toggleHoverReveal };
}
