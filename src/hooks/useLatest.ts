import { useRef, type MutableRefObject } from "react";

/**
 * 「最新值」ref：render 期同步写入，让事件回调 / 快捷键 / effect 读到的永远是
 * **最新一次渲染**的值，而自身身份恒定。
 *
 * 为什么需要它：窗口级 `keydown`、Tauri 事件监听这类**一次性注册**的回调，
 * 在闭包里只能看到注册那一刻的 state。把它们都塞进依赖数组会导致监听反复
 * 解绑重绑；而用 `useState` 做镜像又会让「读值」发生在下一次渲染之后。
 *
 * 用法（注意：在组件顶层无条件调用，和普通 hook 一样）：
 * ```ts
 * const tabsRef = useLatest(tabs);
 * useEffect(() => {
 *   const onKey = () => { console.log(tabsRef.current.length); }; // 永远是新的
 *   window.addEventListener("keydown", onKey);
 *   return () => window.removeEventListener("keydown", onKey);
 * }, [tabsRef]); // 恒定身份 → 只注册一次
 * ```
 *
 * ❗ 名字必须是 `useXxx` 形态。本文件前身在 `FullscreenEditor.tsx` 里叫 `mirror()`，
 * 被 `react-hooks/rules-of-hooks` 判为「在非组件/非 hook 函数里调用了 hook」而报错
 * （2026-09-26）。改名成 hook 后语义也更准：它确实就是一个 hook。
 */
export function useLatest<T>(value: T): MutableRefObject<T> {
  const ref = useRef(value);
  ref.current = value;
  return ref;
}
