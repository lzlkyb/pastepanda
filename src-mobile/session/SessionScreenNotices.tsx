import type { useSessionPointer } from "./useSessionPointer";
import { MobileNotice } from "../ui/MobileNotice";
import styles from "./RcMobileSession.module.css";

export function SessionModeNotice({ hasFrame, canControl, pointer }: {
  hasFrame: boolean;
  canControl: boolean;
  pointer: Pick<ReturnType<typeof useSessionPointer>, "charging" | "dragging" | "scrolling" | "modeHint">;
}) {
  if (!hasFrame || (canControl && !pointer.charging && !pointer.dragging && !pointer.scrolling)) return null;
  return (
    <div className={styles.modePill} role="status">
      {!canControl
        ? "只看模式 · 输入已关闭"
        : pointer.charging ? "长按已识别 · 松手右键，移动拖拽"
        : pointer.dragging ? "拖拽中 · 点释放拖拽结束"
        : pointer.scrolling ? "滚动中 · 点滚动退出"
        : pointer.modeHint}
    </div>
  );
}

export function SessionFrameState({ text, hasFrame, hint, onReturn }: {
  text: string | null | undefined;
  hasFrame: boolean;
  /** §17.3：等画面等太久的一句人话（useRcFrames → rcWaitStage 阈值）；空串不出。 */
  hint?: string;
  onReturn: () => void;
}) {
  if (!text) return null;
  return (
    <div className={hasFrame ? styles.frameNotice : styles.frameWaiting}>
    <MobileNotice compact={hasFrame} tone={hasFrame ? "warning" : "pending"} title={text}
      detail={hint || (hasFrame ? "输入已暂停，收到正常画面后可继续操作。" : undefined)}
      action={<button type="button" className={styles.mkKey} onClick={onReturn}>
        {hasFrame ? "返回设备" : "取消连接"}
      </button>} />
    </div>
  );
}
