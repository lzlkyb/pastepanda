/**
 * rcFeedback — B2（2026-09-23 复审）：动作失败也要出声。
 *
 * 主窗口横幅原先约 9 处动作写成 `if (ok) toast(成功)`，失败分支什么都不做
 * （规则 15.3：失败只 setState 进 `error` 槽时，必须确认承载它的元素在所有
 * 可见性状态下都在——主窗没有错误面板，`RcErrorPanel` 只挂在工作台）。
 * 用户点「立即结束」失败 = 眼里就是「点了没反应」。
 *
 * 收口成一个 helper 而不是 9 处各写 else：失败文案统一带 `rcStore.error`
 * 真因（`run()` 失败时写入的就是它），没有真因也不静默。
 */
import type { ToastFn } from "@/components/Toast";
import { useRcStore } from "@/stores/rcStore";

export async function runRcAction(
  action: () => Promise<boolean>,
  msgs: { ok: string; fail: string },
  toast: ToastFn,
): Promise<boolean> {
  const ok = await action();
  if (ok) {
    toast(msgs.ok, "success");
  } else {
    const err = useRcStore.getState().error;
    toast(err ? `${msgs.fail}：${err}` : msgs.fail, "error");
  }
  return ok;
}
