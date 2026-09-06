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
 * ❗ 光改成冒泡期监听解决不了：两个监听器都在 `window` 上，App 那份注册得更早、
 *   会先跑；`preventDefault()` 也拦不住同级监听器。只有捕获期能抢在它前面，
 *   再用 `stopPropagation()` 把事件截下来。
 *
 * 参考实现：`NoteDialog`（全仓最早、也曾是唯一写对的那个）。
 */
import { useEffect } from "react";

export function useDialogEscape(onClose: () => void, enabled = true) {
  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      // ❗ 输入法合成中的 Esc 归输入法（关候选窗），不能当成“关弹窗”。
      //   中文输入时这是个高频反射动作，当成关闭就会把正在写的内容丢掉。
      if (e.isComposing) return;
      e.stopPropagation();
      e.preventDefault();
      onClose();
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [onClose, enabled]);
}
