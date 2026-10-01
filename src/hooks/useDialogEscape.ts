/**
 * useDialogEscape — 弹窗的 Esc 关闭。所有自己接 Esc 的弹窗都走这一份（规则 #11）。
 *
 * # 🔴 为什么必须是【捕获期 + stopPropagation】
 *
 * `App.tsx` 里有一条**全局的 Esc 分层链**（关最上层弹窗 → 关设置页 →
 * 清多选 → 隐藏窗口），它只认得自己列举过的那批弹窗。对它**不认识**的弹窗，
 * 按 Esc 会发生两件事：弹窗自己关了，**同时** App 那条链也跑一遍——
 * 于是把它下面的东西一并关掉：
 *   - 从设置页打开的弹窗 → **整个设置页跟着没了**（2026-09-06 实际碰到）
 *   - 主列表上的弹窗 → 落到链尾的 `toggleWindow()`，**整个窗口隐藏**
 *
 * ❗ 光改成冒泡期监听解决不了：`App.tsx:1067` 那条链也挂在 `window` 的**冒泡期**，
 *   而且注册更早（App 先挂载），所以后来挂的冒泡期监听永远排在它后面——
 *   同相位比注册顺序，`preventDefault()` 更拦不住同级监听器。
 *   只有捕获期能抢在它前面，再用 `stopPropagation()` 把事件整个截下来
 *   （捕获期一停，冒泡期那趟根本不会发生）。
 *
 * 参考实现：`NoteDialog`（全仓最早、也曾是唯一写对的那个）。
 */
import { useEffect } from "react";
import { isConfirmLayerPresent } from "@/lib/modalLayers";

/**
 * `yieldTo` —— 本弹窗**之外**还要让路的那些层。默认「有统一确认框在场」。
 *
 * 为什么留口子而不是写死：有的弹窗上面还压着非模态的子面板
 * （`NoteDialog` 的 CodeMirror 查找面板），那一层的判据只有它自己知道。
 * 传 `() => false` = 我就是最上层（`ConfirmDialog` 用这个——它自己就是
 * `.z-confirm`，走默认判据会认出自己、把自已冻住）。
 */
export function useDialogEscape(
  onClose: () => void,
  enabled = true,
  yieldTo: () => boolean = isConfirmLayerPresent,
) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // ❗ 输入法合成中的 Esc 归输入法（关候选窗），不能当成“关弹窗”。
      //   中文输入时这是个高频反射动作，当成关闭就会把正在写的内容丢掉。
      if (e.isComposing) return;
      // 🔴 有比我更上层的在场时让路（层序与判据见 `lib/modalLayers.ts`，规则 #11.1）。
      // 不让的后果不是「多关了一层」而是**两层互相制住、按 Esc 什么都不发生**：
      // 本弹窗先跑并 stopPropagation，确认框收不到事件，
      // 而 `lib/confirm.ts` 对已有待决请求是「拒新不顶旧」，本弹窗那次关闭也走不到。
      if (yieldTo()) return;
      e.stopPropagation();
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, enabled, yieldTo]);
}
