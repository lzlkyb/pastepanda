/**
 * dialogMotion.ts — 弹框入场/退场统一动画配置（方案 B：玻璃浮升）
 *
 * 风格：面板从下方浮升 + 过冲回弹（spring 400/24），遮罩淡入并同步起强毛玻璃模糊
 *       （blur 0→12px）；退场加速下沉，无回弹。
 *
 * 用法：
 *   const anim = useDialogAnim();
 *   <motion.div {...anim.backdrop} className="dialog-backdrop" onClick={onClose}>
 *     <motion.div {...anim.panel} className="dialog-box w420" onClick={stop}>
 *
 * 「窗口动画」设置（config.window_animation）关闭时降级为即时显隐（duration 0）。
 * 返回的对象是模块级稳定引用，可安全用于 memo 组件的 props 展开。
 */
import type { TargetAndTransition, Transition } from "framer-motion";
import { useAppStore } from "@/stores/appStore";

export interface DialogMotionProps {
  initial: TargetAndTransition;
  animate: TargetAndTransition;
  exit: TargetAndTransition;
  transition: Transition;
}

export interface DialogAnim {
  backdrop: DialogMotionProps;
  panel: DialogMotionProps;
}

const ENABLED: DialogAnim = {
  backdrop: {
    initial: { opacity: 0, backdropFilter: "blur(0px)" },
    animate: { opacity: 1, backdropFilter: "blur(12px)" },
    exit: { opacity: 0, backdropFilter: "blur(0px)", transition: { duration: 0.18, ease: "easeIn" } },
    transition: { duration: 0.24, ease: "easeOut" },
  },
  panel: {
    initial: { opacity: 0, y: 38, scale: 0.97 },
    animate: { opacity: 1, y: 0, scale: 1 },
    exit: { opacity: 0, y: 24, scale: 0.98, transition: { duration: 0.2, ease: [0.4, 0, 1, 1] } },
    transition: { type: "spring", stiffness: 400, damping: 24 },
  },
};

const DISABLED: DialogAnim = {
  backdrop: {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0, transition: { duration: 0 } },
    transition: { duration: 0 },
  },
  panel: {
    initial: { opacity: 0 },
    animate: { opacity: 1 },
    exit: { opacity: 0, transition: { duration: 0 } },
    transition: { duration: 0 },
  },
};

/** 跟随「窗口动画」设置的弹框动画配置（主窗口与编辑器窗口各自读取本窗口的 store） */
export function useDialogAnim(): DialogAnim {
  const enabled = useAppStore((s) => s.config.window_animation);
  return enabled ? ENABLED : DISABLED;
}
