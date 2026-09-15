/**
 * PromptDialogHost —— 统一输入弹窗的渲染宿主。
 * 订阅 lib/prompt 的请求并渲染 PromptDialog；挂在 App 根部一次。
 */
import { useEffect, useReducer } from "react";
import { PromptDialog } from "@/components/PromptDialog";
import { getPrompt, resolvePrompt, subscribePrompt } from "@/lib/prompt";

export function PromptDialogHost() {
  const [, force] = useReducer((x: number) => x + 1, 0);
  useEffect(() => subscribePrompt(() => force()), []);
  const req = getPrompt();

  return (
    <PromptDialog
      open={req !== null}
      title={req?.title ?? ""}
      message={req?.message}
      placeholder={req?.placeholder}
      defaultValue={req?.defaultValue ?? ""}
      confirmText={req?.confirmText}
      cancelText={req?.cancelText}
      onConfirm={(v) => resolvePrompt(v)}
      onCancel={() => resolvePrompt(null)}
    />
  );
}
