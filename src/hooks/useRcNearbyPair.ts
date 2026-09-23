/**
 * useRcNearbyPair — A3 局域网配对在**界面这一侧**的状态与轮询。
 *
 * 从 `RcPairDialog.tsx` 拆出来的：那个对话框要同时装下「邀请码」与「局域网」
 * 两条流程，红线 300 行放不下，而那些状态本身与对话框结构无关。
 *
 * # 🔴 轮询不只是「读状态」
 *
 * `rc_nearby_status` 在后端**顺带重传**该重传的握手包（见 `commands/rc_pair.rs`）。
 * 也就是说：界面开着一轮 2 秒的轮询，本身就是配对能扛住 UDP 丢包的原因。
 * 反过来说，**没有人在看的时候不需要重传**——所以窗口不可见就停（规则 #8），
 * 语义上与「用户走开了，这次配对不该继续往后推」是一致的。
 *
 * 也因此**不要**把它挪进 `rcStore` 那种 app 级轮询：配对是模态框里的临时会话，
 * 对话框一关就该停。
 *
 * # `done` 为什么必须留一份在本地
 *
 * 后端 `rc_nearby_status` 里那个 `done`（🔴 P1-7 起）**60 秒窗口内多重可读**——
 * 主窗口与工作台两个轮询者都看得见，谁先读到不影响另一个。界面仍要自留一份：
 * 轮询拿回的是「后端投影」，完成屏要一直挂到本对话框关闭；窗口内每 2 秒都会
 * 拿回同一条，按 `at_ms` 去重防止无谓重渲染（去重归界面，后端不归）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { logger } from "@/lib/logger";
import { useWindowVisible } from "@/hooks/useWindowVisible";
import {
  rcNearbyCancel,
  rcNearbyConfirm,
  rcNearbyPair,
  rcNearbyStatus,
  type RcNeighbor,
  type RcPairDone,
  type RcPairOutcome,
  type RcPairPrompt,
} from "@/lib/api/rcPair";

/**
 * 轮询间隔（毫秒）。
 *
 * 2 秒而不是 5 秒：附近设备的 TTL 是 20 秒，而配对窗口只有 60 秒。
 * 慢一轮就可能让用户看到的邻居已经走了，或者错过一次重传。
 * 只有对话框开着时才跑，所以这个频率的影响面很小。
 */
export const NEARBY_POLL_MS = 2000;

/**
 * A4（2026-09-23 复审）：`done` 在后端 60 秒窗口内**多重可读**（P1-7），而
 * 挂载内的 `prev?.at_ms` 比较挡不住「关掉对话框又打开 → 上一次配对的完成屏
 * 重播」。模块级记「已经给用户看过的那条的 at_ms」：比它旧或相同的不再入
 * state——完成屏一次会话只弹一次，跨挂载有效。
 */
let shownDoneAtMs = 0;

export interface RcNearbyPair {
  neighbors: RcNeighbor[];
  /** 正在进行的那一轮配对（没有则 null）。 */
  pair: RcPairPrompt | null;
  /** 刚配上的那一台。**一直留着**，直到本 hook 卸载（对话框关闭）。 */
  done: RcPairDone | null;
  busy: boolean;
  /** 手动刷一次（配对前后用，免得等满 2 秒）。 */
  refresh: () => Promise<void>;
  /** 对一台邻居发起配对。失败抛出，由调用方 toast。 */
  startPair: (peerId: string) => Promise<void>;
  /** 本端确认「两边一样」。 */
  confirm: () => Promise<RcPairOutcome>;
  /** 取消这一轮。 */
  cancel: () => Promise<void>;
}

export function useRcNearbyPair(): RcNearbyPair {
  const [neighbors, setNeighbors] = useState<RcNeighbor[]>([]);
  const [pair, setPair] = useState<RcPairPrompt | null>(null);
  const [done, setDone] = useState<RcPairDone | null>(null);
  const [busy, setBusy] = useState(false);
  const aliveRef = useRef(true);
  const visible = useWindowVisible();

  const refresh = useCallback(async () => {
    try {
      const st = await rcNearbyStatus();
      if (!aliveRef.current) return;
      setNeighbors(st.neighbors);
      // 后端是唯一权威：它说没有会话了就是没有了（过期 / 被对方取消）。
      setPair(st.pair);
      // ❗ 只在拿到时写入，不拿 None 去清——见文件头。
      // A4：去重收口到模块级 `shownDoneAtMs`（见其注释）——同一条既不逐 2s 重渲染，
      // 也不会在重开对话框时重播。
      if (st.done && st.done.at_ms > shownDoneAtMs) {
        shownDoneAtMs = st.done.at_ms;
        setDone(st.done);
      }
    } catch (e) {
      // 不 toast：这是 2 秒一次的轮询，失败弹一次就是刷屏。
      logger.warn("获取附近设备失败", e);
    }
  }, []);

  useEffect(() => {
    if (!visible) return;
    aliveRef.current = true;
    void refresh();
    const t = window.setInterval(() => void refresh(), NEARBY_POLL_MS);
    return () => {
      aliveRef.current = false;
      window.clearInterval(t);
    };
  }, [refresh, visible]);

  const startPair = useCallback(async (peerId: string) => {
    setBusy(true);
    try {
      // 拿返回值立刻就进核对屏（这时 pin 多半还是空串），
      // 不干等下一轮轮询——用户刚点完按钮，屏幕上必须马上有反应。
      const p = await rcNearbyPair(peerId);
      if (aliveRef.current) setPair(p);
    } finally {
      setBusy(false);
    }
  }, []);

  const confirm = useCallback(async (): Promise<RcPairOutcome> => {
    setBusy(true);
    try {
      const out = await rcNearbyConfirm();
      // 两端都确认时后端已经写好 `done`，这一拉就是完成屏的数据。
      await refresh();
      return out;
    } finally {
      setBusy(false);
    }
  }, [refresh]);

  const cancel = useCallback(async () => {
    try {
      await rcNearbyCancel();
    } catch (e) {
      // 取消失败不该拦住界面：本地照样回到入口屏，后端那 60 秒窗口自己会过期。
      logger.warn("取消配对失败", e);
    }
    if (aliveRef.current) setPair(null);
    await refresh();
  }, [refresh]);

  return { neighbors, pair, done, busy, refresh, startPair, confirm, cancel };
}
