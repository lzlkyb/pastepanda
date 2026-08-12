/**
 * ConfirmDialogHost.tsx —— 审查：统一确认弹窗的渲染宿主。
 * 订阅 lib/confirm 的请求并渲染 ConfirmDialog；挂在 App 根部一次。
 */
import { useEffect, useReducer } from "react";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { getConfirm, resolveConfirm, subscribeConfirm } from "@/lib/confirm";

export function ConfirmDialogHost() {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => subscribeConfirm(() => force()), []);
  const req = getConfirm();

  return (
    <ConfirmDialog
      open={req !== null}
      title={req?.title ?? ""}
      message={req?.message ?? ""}
      confirmText={req?.confirmText}
      cancelText={req?.cancelText}
      variant={req?.variant}
      onConfirm={() => resolveConfirm(true)}
      onCancel={() => resolveConfirm(false)}
    />
  );
}
