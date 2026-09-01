/**
 * 「笔记弹窗刚关上」的回调（知识库 A 阶段）。
 *
 * 为何不给 NoteDialog 传 onSaved：弹窗是全局挂在 App.tsx 的，要传回调就得把回调
 * 存进 store——为一次列表刷新引入一个全局可变回调不值。监听 `noteDraft` 从非空
 * 变空就够了。
 *
 * 代价：取消（未保存）也会触发一次。一次本机查询，无所谓。
 *
 * 收口的理由（规则 #11）：笔记列表与待沉淀面板都要这么干。各写一份 `wasOpen`
 * 状态机，迟早有一份忘了重置而变成死循环。
 */
import { useEffect, useRef } from "react";
import { useDialogStore } from "@/stores/dialogStore";

export function useNoteDialogClosed(onClosed: () => void): void {
  const noteDraft = useDialogStore((s) => s.noteDraft);

  // 回调进 ref：否则调用方每次渲染新建一个函数就会重跑 effect，
  // 而 effect 里又会 set 状态 → 无限循环。
  const cbRef = useRef(onClosed);
  cbRef.current = onClosed;

  const wasOpenRef = useRef(false);
  useEffect(() => {
    if (noteDraft) {
      wasOpenRef.current = true;
    } else if (wasOpenRef.current) {
      wasOpenRef.current = false;
      cbRef.current();
    }
  }, [noteDraft]);
}
