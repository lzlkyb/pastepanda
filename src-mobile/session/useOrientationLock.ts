/**
 * useOrientationLock — 「横屏」按钮的机械臂（2026-10-01 真机联调补）。
 *
 * 设计稿（触摸语义与坐标系 §6）定的是「尊重系统旋转锁」——用户系统锁了竖屏
 * 时旋转手势够不着，所以入口改成显式按钮（用户拍板：连上画面后自己点）：
 * 点「横屏」= 请求全屏 + 锁 landscape；点「竖屏」= 解锁 + 退全屏。朝向真正
 * 变化后，共用的 useMobileLayout 自动接管会话布局——本 hook
 * 只负责旋转，不碰工具条状态（单一数据源：按钮文案也由 capsule.landscape 决定）。
 *
 * Android WebView 的 screen.orientation.lock 要求文档先进全屏（wry 的
 * RustWebChromeClient 已实现 onShowCustomView 全屏链）。失败必须诚实报话
 * （规则 15.3）：返回 hint 给工具条同域展示，绝不静默。
 */
import { useCallback, useEffect, useRef, useState } from "react";

export function useOrientationLock() {
  /** Failure stays until recovered or dismissed; it must not expire mid-reading. */
  const [hint, setHint] = useState("");
  const lockedRef = useRef(false);
  const say = useCallback((msg: string) => setHint(msg), []);
  const clearHint = useCallback(() => setHint(""), []);

  const enterLandscape = useCallback(async () => {
    // 全屏与旋转锁是两道闸，失败原因不同、修法不同，提示必须分开说（规则 15.3）。
    let fullscreenBlocked = false;
    try {
      if (!document.fullscreenElement) await document.documentElement.requestFullscreen();
    } catch {
      fullscreenBlocked = true; // 全屏被拒时锁横屏多半也会失败，但仍先试：有的 ROM 只拦全屏
    }
    try {
      // TS 的 ScreenOrientation 暂无 lock/unlock（即将进 lib.dom）——运行时
      // Android Chrome/WebView 稳定支持，先断言再调（失败走 catch 提示）。
      const orient = screen.orientation as ScreenOrientation & {
        lock: (o: string) => Promise<void>;
        unlock: () => void;
      };
      await orient.lock("landscape");
      lockedRef.current = true;
      say("");
    } catch {
      say(fullscreenBlocked
        ? "这台手机不允许进入全屏，横屏锁定被跳过；试试打开系统的自动旋转"
        : "系统没有让锁定横屏，试试打开系统的自动旋转");
    }
  }, [say]);

  const exitLandscape = useCallback(() => {
    setHint("");
    try {
      const orient = screen.orientation as ScreenOrientation & {
        lock: (o: string) => Promise<void>;
        unlock: () => void;
      };
      orient.unlock();
    } catch {
      /* 已是自由旋转，不用管 */
    }
    lockedRef.current = false;
    if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
  }, []);

  // 会话卸载（断开/换页）必须还原：锁着横屏离开，下个页面会横着开场。
  // 卸载后 setState 无意义，所以只做还原不做提示。
  useEffect(
    () => () => {
      if (!lockedRef.current) return;
      try {
        (screen.orientation as ScreenOrientation & { unlock: () => void }).unlock();
      } catch {
        /* 同上 */
      }
      if (document.fullscreenElement) void document.exitFullscreen().catch(() => {});
    },
    [],
  );

  return { hint, clearHint, enterLandscape, exitLandscape };
}
