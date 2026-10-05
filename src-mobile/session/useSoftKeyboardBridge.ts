/**
 * useSoftKeyboardBridge — 软键盘桥的挂载/销毁 + 键盘开合状态。
 *
 * 从会话壳拆出（规则 7：壳文件压回 300 行内）。桥依赖的发送回调都是稳定
 * 引用，整生命周期只挂一次（StrictMode 双挂载安全：mount/destroy 成对）；
 * 打字/直控档经 keyModeRef 晚绑定——切换键档不重挂桥。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { keyToVk } from "@/lib/rcKeyMap";
import { SoftKeyboardBridge } from "./SoftKeyboardBridge";
import type { MobileKeyMode } from "./SessionToolbar";

export function useSoftKeyboardBridge({
  sendText,
  sendKeyDown,
  sendKeyUp,
  sendKeyPair,
  keyModeRef,
}: {
  sendText: (t: string) => void;
  sendKeyDown: (vk: number) => void;
  sendKeyUp: (vk: number) => void;
  sendKeyPair: (vk: number) => void;
  keyModeRef: React.MutableRefObject<MobileKeyMode>;
}) {
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const bridgeRef = useRef<SoftKeyboardBridge | null>(null);
  useEffect(() => {
    const bridge = new SoftKeyboardBridge({
      onText: (t) => sendText(t),
      onDirectKeyDown: (e) => {
        if (keyModeRef.current !== "direct") {
          if (e.key === "Enter") {
            e.preventDefault();
            sendKeyPair(0x0d);
          }
          return; // 打字档：非候选键流进 input（组串用）
        }
        const vk = keyToVk(e);
        if (vk == null) return;
        e.preventDefault();
        sendKeyDown(vk);
      },
      onDirectKeyUp: (e) => {
        if (keyModeRef.current !== "direct") return;
        const vk = keyToVk(e);
        if (vk == null) return;
        sendKeyUp(vk);
      },
      onFocusChange: (focused) => {
        if (focused) setKeyboardOpen(true);
      },
    });
    bridge.mount();
    bridgeRef.current = bridge;
    return () => {
      bridgeRef.current = null;
      bridge.destroy();
    };
    // keyModeRef 恒稳定，不进依赖；发送回调按桥的契约必须稳定
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sendText, sendKeyDown, sendKeyUp, sendKeyPair]);
  const openRef = useRef(keyboardOpen);
  openRef.current = keyboardOpen;
  const keyMode = keyModeRef.current;
  useEffect(() => {
    if (keyboardOpen && keyMode === "direct") bridgeRef.current?.focus();
  }, [keyboardOpen, keyMode]);
  const toggleKeyboard = useCallback(() => {
    if (openRef.current) bridgeRef.current?.blur();
    else if (keyModeRef.current === "direct") bridgeRef.current?.focus();
    setKeyboardOpen(!openRef.current);
  }, [keyModeRef]);
  return { keyboardOpen, toggleKeyboard };
}
