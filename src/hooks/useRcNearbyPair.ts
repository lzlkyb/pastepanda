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
 * 也因此**不要**把它挪进 `rcStore` 那种 app 级轮询：配对是界面上的临时会话，
 * 配对界面一关就该停。常驻卡（`rc/RcNearbyPairPane`）挂着它时同理——
 * 它跟着设备页的生死走，不是全局后台任务。
 *
 * # `done` 为什么必须留一份在本地
 *
 * 后端 `rc_nearby_status` 里那个 `done`（🔴 P1-7 起）**60 秒窗口内多重可读**——
 * 主窗口与工作台多个轮询者都看得见，谁先读到不影响另一个。界面仍要自留一份：
 * 乙方案（2026-09-26）后完成屏已删，`done` 的消费点是「关窗 + toast + 选中新设备」
 * 这类一次性副作用——正因如此**去重必须可靠**，重开对话框重播那条 toast 会变成噪音。
 * 按 `at_ms` 去重（去重归界面，后端不归）。
 *
 * 首页观察者只消费被请求方的 done；主动配对的完成留给统一弹窗。
 * 弹窗接手时首页观察者暂停，避免一次完成被隐藏组件抢先消费。
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
 * 只有配对相关界面开着时才跑，所以这个频率的影响面很小。
 */
export const NEARBY_POLL_MS = 2000;

/**
 * 空闲态轮询间隔（毫秒）——**没有配对在进行时**用这个。
 *
 * 来源：常驻卡（`rc/RcNearbyPairPane``）把附近列表从「对话框里才有」
 * 变成「远程电脑主页一直在」，2 秒一轮就成了常驻开销。没有配对时，
 * `rc_nearby_status` 不重传任何包（见文件头），慢一轮只影响邻居列表的
 * 新鲜度——TTL 20 秒，5 秒仍在「刚听到」的感知内。
 *
 * ❗ 这里只做**间隔收俭**，没有做更激进的手段（共享请求 / 事件推送）：
 * 未实测过那些方案在本机的收益，不把没量过的东西写进注释。
 */
export const NEARBY_IDLE_POLL_MS = 5000;

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
  loading: boolean;
  error: string | null;
  /** 手动刷一次（配对前后用，免得等满一个轮询周期）。 */
  refresh: () => Promise<void>;
  /** 对一台邻居发起配对。失败抛出，由调用方 toast。 */
  startPair: (peerId: string) => Promise<void>;
  /** 本端确认「两边一样」。 */
  confirm: () => Promise<RcPairOutcome>;
  /** 取消这一轮。 */
  cancel: () => Promise<void>;
}

export interface UseRcNearbyPairOpts {
  enabled?: boolean;
  incomingOnly?: boolean;
  /**
   * 空闲态（没有配对在进行）的轮询间隔，默认 [`NEARBY_POLL_MS`]。
   *
   * 对话框保持默认：它开着就是为了配对，2 秒是配对窗口的需要。
   * 常驻卡传 [`NEARBY_IDLE_POLL_MS`]：没人配对时没必要那么密。
   */
  idlePollMs?: number;
}

export function useRcNearbyPair(opts?: UseRcNearbyPairOpts): RcNearbyPair {
  const [neighbors, setNeighbors] = useState<RcNeighbor[]>([]);
  const [pair, setPair] = useState<RcPairPrompt | null>(null);
  const [done, setDone] = useState<RcPairDone | null>(null);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const aliveRef = useRef(true);
  const visible = useWindowVisible();
  const idlePollMs = opts?.idlePollMs ?? NEARBY_POLL_MS;
  const enabled = opts?.enabled ?? true;
  const incomingOnly = opts?.incomingOnly ?? false;
  /** 有没有配对在进行。轮询 effect 只认这个布尔（见那边的 🔴 注释）。 */
  const pairing = pair !== null;

  const refresh = useCallback(async () => {
    try {
      const st = await rcNearbyStatus();
      if (!aliveRef.current) return;
      setError(null);
      setNeighbors(st.neighbors);
      // 后端是唯一权威：它说没有会话了就是没有了（过期 / 被对方取消）。
      setPair(st.pair);
      // ❗ 只在拿到时写入，不拿 None 去清——见文件头。
      // A4：去重收口到模块级 `shownDoneAtMs`（见其注释）——同一条既不逐 2s 重渲染，
      // 也不会在重开对话框时重播。
      if (st.done && (!incomingOnly || !st.done.initiator) && st.done.at_ms > shownDoneAtMs) {
        shownDoneAtMs = st.done.at_ms;
        setDone(st.done);
      }
    } catch (e) {
      // 不 toast：这是 2 秒一次的轮询，失败弹一次就是刷屏。
      logger.warn("获取附近设备失败", e);
      if (aliveRef.current) setError(String(e));
    } finally {
      if (aliveRef.current) setLoading(false);
    }
  }, [incomingOnly]);

  useEffect(() => {
    if (!visible || !enabled) return;
    aliveRef.current = true;
    void refresh();
    // 配对在进行中走 2 秒（重传与确认都等不起），空闲走 idlePollMs。
    // 进出配对时整个 effect 重跑一轮：进配对那一刻立刻补一次 refresh，
    // 不干等下一个间隔——用户刚点完按钮，屏幕上必须马上有反应。
    //
    // 🔴 依赖必须是 `pairing` 这个**布尔值**，不能是 `pair` 对象：
    // 后端每轮都序列化出一份新 `PairPrompt`（引用必变），拿对象当依赖会让
    // 这个 effect 每轮重跑 → 每次重跑都立刻 refresh → 再拿新对象 →
    // 变成不受间隔约束的忙轮询（2 秒的窗口内把 CPU 打满）。布尔值只在
    // 「开始配对 / 配对结束」两个时刻翻，重跑次数与轮询次数解耦。
    const t = window.setInterval(() => void refresh(), pairing ? NEARBY_POLL_MS : idlePollMs);
    return () => {
      aliveRef.current = false;
      window.clearInterval(t);
    };
  }, [refresh, visible, pairing, idlePollMs, enabled]);

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

  return { neighbors, pair, done, busy, loading, error, refresh, startPair, confirm, cancel };
}
