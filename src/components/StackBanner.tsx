import { memo } from "react";
import { Layers, X } from "lucide-react";
import { useAppStore } from "@/stores/appStore";
import { stackPasteAll, exitStack } from "@/lib/api";
import styles from "./StackBanner.module.css";

/** 剪贴板栈横幅 — 栈模式激活时显示在卡片列表上方 */
export const StackBanner = memo(function StackBanner() {
  const stackMode = useAppStore((s) => s.stackMode);
  const stackItems = useAppStore((s) => s.stackItems);
  const stackPasted = useAppStore((s) => s.stackPasted);
  const stackCollected = useAppStore((s) => s.stackCollected);

  if (!stackMode) return null;

  const remaining = stackItems.length;
  // 修复 Low：分母用真实收集总数（含被 50 上限截断丢弃的），避免进度虚高
  const total = Math.max(stackCollected, stackPasted + remaining);

  return (
    <div className={styles.banner}>
      <span className={styles.dot} />
      <div className={styles.text}>
        <div className={styles.title}>
          <Layers size={12} />
          栈模式 · {remaining > 0 ? `剩余 ${remaining} 条` : "等待收集"}
        </div>
        <div className={styles.sub}>
          {stackPasted > 0 ? `已粘贴 ${stackPasted}/${total} · ` : ""}
          Ctrl+C 收集 · Ctrl+Shift+P 逐条粘贴
        </div>
      </div>
      {remaining > 0 && (
        <button className={styles.pasteAllBtn} onClick={() => stackPasteAll()} title="连续粘贴剩余全部条目">
          ▶ 全部粘贴
        </button>
      )}
      <button className={styles.exitBtn} onClick={() => exitStack()} title="退出栈模式 (Ctrl+Shift+K)">
        <X size={12} /> 退出
      </button>
    </div>
  );
});
