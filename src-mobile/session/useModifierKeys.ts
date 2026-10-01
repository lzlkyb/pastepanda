/**
 * useModifierKeys — 修饰键条 sticky 挂起状态机（design §5.2）。
 *
 * 语义：点按 = 挂起（立即发 key down，远端立即可见生效）；下一次「有后果的
 * 操作」（点击/功能键/文本，由输入层的 onComboCompleted 通知）完成后自动解除
 * （逆序补发 up）；挂起中再点 = 取消（立即补发 up）。锁定不做（P1 明确不做项）。
 *
 * Win 键与其它修饰键同权：桌面拦 Meta 是防本机被劫持，手机没有这个问题
 * （design §5.2 的移动端差异点）。
 */
import { useCallback, useRef, useState } from "react";

export interface ModKeyDef {
  id: string;
  label: string;
  vk: number;
}

/** 键序即展示序；vk 与桌面 releaseModifiers 的六键口径一致（Win 用左键 0x5b）。 */
export const MOD_KEYS: ModKeyDef[] = [
  { id: "ctrl", label: "Ctrl", vk: 0xa2 },
  { id: "alt", label: "Alt", vk: 0xa4 },
  { id: "shift", label: "Shift", vk: 0xa0 },
  { id: "win", label: "Win", vk: 0x5b },
];

export function useModifierKeys({
  sendKeyDown,
  sendKeyUp,
}: {
  sendKeyDown: (vk: number) => void;
  sendKeyUp: (vk: number) => void;
}) {
  const [pending, setPending] = useState<string[]>([]);
  const pendingRef = useRef<string[]>([]);
  pendingRef.current = pending;

  const vkOf = useCallback(
    (id: string) => MOD_KEYS.find((m) => m.id === id)?.vk ?? 0,
    [],
  );

  /** 点按修饰键：挂起 / 取消挂起。 */
  const toggle = useCallback(
    (id: string) => {
      const list = pendingRef.current;
      if (list.includes(id)) {
        const vk = vkOf(id);
        pendingRef.current = list.filter((m) => m !== id);
        setPending(pendingRef.current);
        if (vk) sendKeyUp(vk);
      } else {
        const vk = vkOf(id);
        pendingRef.current = [...list, id];
        setPending(pendingRef.current);
        if (vk) sendKeyDown(vk);
      }
    },
    [vkOf, sendKeyDown, sendKeyUp],
  );

  /** 组合完成：逆序补发 up（Ctrl+Alt+Del → Del 发完后 Alt、Ctrl 依次松开）。 */
  const releasePending = useCallback(() => {
    const list = pendingRef.current;
    if (list.length === 0) return;
    for (let i = list.length - 1; i >= 0; i--) {
      const vk = vkOf(list[i]);
      if (vk) sendKeyUp(vk);
    }
    pendingRef.current = [];
    setPending([]);
  }, [vkOf, sendKeyUp]);

  /** 失焦/旋转/会话结束的兜底：与 releasePending 相同，但供 releaseAll 链调用。 */
  const releaseAll = releasePending;

  return { pending, toggle, releasePending, releaseAll };
}
