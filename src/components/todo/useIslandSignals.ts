/**
 * 岛的两个 Rust 广播信号（从 TodoIsland 拆出，规则 #7：该文件 300 行红线）。
 *
 * 这两个 Hook 只订阅事件、不解析语义——语义（什么时候切 peek、什么时候点亮 glow）
 * 由 TodoIsland 的舞台机决定；这里只保证「Rust 发什么，组件拿到什么」。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { listen } from "@tauri-apps/api/event";

/** 失败提示的自退场时长：够读完一句话，又不常驻挡列表 */
const NOTICE_MS = 3200;

/**
 * 失败提示（从 TodoIsland 拆出，规则 #7）：提在**岛层**——勾选/输入的失败可能
 * 发生在列表正要收起的那一刻，提示必须留在触发它的那个可见域里
 * （规则 §15.1 / §15.3），不能随列表一起被卸载。
 * 返回 [提示文字, 闪示函数]；传 null = 立即清除。
 */
export function useFlashNotice(): [string | null, (msg: string | null) => void] {
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<number | undefined>(undefined);
  const flashNotice = useCallback((msg: string | null) => {
    window.clearTimeout(noticeTimer.current);
    if (!msg) {
      setNotice(null);
      return;
    }
    setNotice(msg);
    noticeTimer.current = window.setTimeout(() => setNotice(null), NOTICE_MS);
  }, []);
  useEffect(() => () => window.clearTimeout(noticeTimer.current), []);
  return [notice, flashNotice];
}

/** hover 视觉：由 Rust 的光标轮询广播（60ms 滞回判定），**不是 CSS :hover**——窗口默认穿透。
 *  语义（吸附双态设计稿 §3）：代表「形内停留达标，可以切 peek」——收起两态要停留 4 拍
 *  （≈240ms）才发 true；列表/输入两态立即发（闲置自收计时器靠它清掉）。 */
export function useHoverVisual(): boolean {
  const [hover, setHover] = useState(false);
  useEffect(() => {
    const off = listen<boolean>("todo-island-hover", (e) => setHover(e.payload));
    return () => void off.then((f) => f());
  }, []);
  return hover;
}

/** 意图视觉：形内连续停留 3 拍（≈180ms）时 Rust 发 true、离开补发 false。
 *  此刻窗口**仍穿透**——glow 是「它注意到我了」的预告，不是拦截；掠过不点亮。
 *  与 useHoverVisual 分开监听：两者由 Rust 按拍数先后发出，不是同一信号。 */
export function useIntentVisual(): boolean {
  const [intent, setIntent] = useState(false);
  useEffect(() => {
    const off = listen<boolean>("todo-island-intent", (e) => setIntent(e.payload));
    return () => void off.then((f) => f());
  }, []);
  return intent;
}
