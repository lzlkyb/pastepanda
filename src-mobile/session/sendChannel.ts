/**
 * sendChannel — 手机端输入/设置事件的唯一发送收口。
 *
 * sendEvent 是全部手势与设置类事件的出口（守卫单测钉住：hook 内不允许
 * 出现第二个发送调用点）。lastInputAt 在这里记「有后果的操作」时间戳
 * （hover/up/设置类不制造响应样本）；失败经 onSettled 上报给健康监测
 * （规则 15.3），手势回调本身不吃异常。
 */
import { rcSendInput } from "@/lib/api/rcCommands";
import type { RcInputEvent } from "@/lib/api/rcFrameTypes";

/**
 * 安全发送（可等待版）：显式提交（文本草稿）需要拿到失败结果内联展示；
 * 手势路径用 sendEvent。
 */
export async function sendChecked(event: RcInputEvent, lastInputAt?: React.RefObject<number>): Promise<void> {
  // Count consequential input at the single send boundary; hover/up/settings must not manufacture response samples.
  const consequential = event.kind === "text" || event.kind === "wheel" ||
    ((event.kind === "key" || event.kind === "mouse_button") && event.down);
  const at = Date.now();
  if (consequential && lastInputAt) lastInputAt.current = at;
  const failed = () => {
    if (consequential && lastInputAt?.current === at) lastInputAt.current = 0;
  };
  try {
    await rcSendInput(event);
  } catch (error) {
    failed();
    throw error;
  }
}

/** onSettled = 发送成功/失败的统一出口；手势路径借此点亮「未送达」横幅。 */
export function sendEvent(
  event: RcInputEvent,
  lastInputAt?: React.RefObject<number>,
  onSettled?: (ok: boolean) => void,
): void {
  void sendChecked(event, lastInputAt).then(
    () => onSettled?.(true),
    () => onSettled?.(false), /* 手势发送不打断事件回调，失败走 onSettled 上报 */
  );
}
