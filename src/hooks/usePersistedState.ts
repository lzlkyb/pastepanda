/**
 * usePersistedState — 带 localStorage 持久化的 `useState`。
 *
 * 收的是这两段到处在抄的样板代码（规则 #11）：
 *   读：try → 解析 → 脏值/异常回默认
 *   写：effect 里 try → 写不进就算了
 *
 * # 两条不能省的约束
 *
 * 🔴 **写入必须在 effect 里，不能写在 `setState` 的 updater 里。**
 *   updater 可能在 render 阶段被调（StrictMode 下会双调），而写 localStorage
 *   是副作用。项目在 `App.tsx` 的 `aiAwarenessActive` 上撞过这个坑。
 *
 * 🔴 **读也必须包 try。** 隐私模式 / 禁用本地存储时，`localStorage.getItem`
 *   是会**抛异常**的，不是返回 null。`NoteBacklinks` 原先就漏了这一层，
 *   那种环境下整个组件会直接渲染失败——而它存的只是一个「展开/折叠」偏好。
 *
 * 展示层偏好读写失败一律**静默回默认**，不弹提示：用户没请求过这件事，
 * 为「没记住折叠状态」弹一句只是噪声（区别于规则 #15.3 说的那种静默失败）。
 */
import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";

interface Options<T> {
  /** 字符串 → 值。默认 `JSON.parse`。抛异常或返回脏值时走 fallback。 */
  parse?: (raw: string) => T;
  /** 值 → 字符串。默认 `JSON.stringify`。 */
  serialize?: (v: T) => string;
  /** 为 false 时只读不写（例：新建未保存的草稿不应该覆盖全局偏好）。 */
  enabled?: boolean;
}

export function usePersistedState<T>(
  key: string,
  fallback: T,
  opts?: Options<T>,
): [T, Dispatch<SetStateAction<T>>] {
  // ❗ parse / serialize 常常是行内箭头函数，每次渲染都是新引用。
  //   直接写进依赖会让写入 effect 每渲染都跑一遍；放 ref 里取最新的就行。
  const parseRef = useRef(opts?.parse);
  const serializeRef = useRef(opts?.serialize);
  parseRef.current = opts?.parse;
  serializeRef.current = opts?.serialize;

  const enabled = opts?.enabled ?? true;

  const [value, setValue] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key);
      if (raw === null) return fallback;
      const p = parseRef.current;
      return p ? p(raw) : (JSON.parse(raw) as T);
    } catch {
      return fallback;
    }
  });

  useEffect(() => {
    if (!enabled) return;
    try {
      const s = serializeRef.current;
      localStorage.setItem(key, s ? s(value) : JSON.stringify(value));
    } catch {
      /* 隐私模式 / 配额满：写不进只是下次回默认 */
    }
  }, [key, value, enabled]);

  return [value, setValue];
}
