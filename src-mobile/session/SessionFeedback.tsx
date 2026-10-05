import { MobileNotice } from "../ui/MobileNotice";
import { MobileToast } from "../ui/MobileToast";
import type { useSessionClipboard } from "./useSessionClipboard";
import type { useSessionPointer } from "./useSessionPointer";
import type { useOrientationLock } from "./useOrientationLock";
import ui from "../ui/MobileUi.module.css";

/**
 * 会话反馈槽的聚合出口（feedbackSlot 内）：错误互相不掩埋（规则 15.3），
 * 横屏失败与剪贴板错误同时存在时两条都看得见；只有指针提示（success/warning
 * 级的低价值信息）让位给任何真实结果。发送失败横幅与横屏首次引导的教学倒计时
 * 也在这里出——触发与反馈同可见性域。
 */
export function SessionFeedback({ pointer, orient, clipboard, sendFailed, onSendFailDismiss, teach }: {
  pointer: Pick<ReturnType<typeof useSessionPointer>, "hint" | "hintTone" | "clearHint">;
  orient: Pick<ReturnType<typeof useOrientationLock>, "hint" | "clearHint">;
  clipboard: ReturnType<typeof useSessionClipboard>;
  /** 最近一次输入/设置事件发送失败（恢复后由 hook 自动翻回 false）。 */
  sendFailed?: boolean;
  onSendFailDismiss: () => void;
  /** 横屏首次引导的教学倒计时（useImmersiveCapsule phase=teaching）。 */
  teach?: { secondsLeft: number; onEnd: () => void };
}) {
  const clip = !clipboard.clipOpen ? clipboard.feedback : null;
  return (
    <>
      {sendFailed && (
        <MobileToast placement="flow" tone="error" title="操作未送达电脑"
          detail="最近的输入发送失败，请检查连接；恢复后此提示自动消失。"
          onDismiss={onSendFailDismiss} />
      )}
      {teach && (
        <MobileNotice variant="banner" tone="info" title="工具栏在这里"
          detail={`画面、画质、剪贴板、断开都在这列。${teach.secondsLeft} 秒后自动收起，之后点「工具」随时唤出。`}
          onDismiss={teach.onEnd} />
      )}
      {orient.hint && <MobileToast placement="flow" tone="error" title="未能锁定横屏" detail={orient.hint} onDismiss={orient.clearHint} />}
      {clip && <MobileToast placement="flow" {...clip} onDismiss={clipboard.dismiss}
        action={<button type="button" className={ui.textButton} onClick={clipboard.openClip}>打开剪贴板</button>} />}
      {!orient.hint && !clip && pointer.hint &&
        <MobileToast placement="flow" tone={pointer.hintTone} title={pointer.hint} onDismiss={pointer.clearHint} />}
    </>
  );
}
