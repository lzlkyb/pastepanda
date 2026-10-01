/**
 * usePairCodeVisibility — 配对码的「显示 / 收起」状态机（2026-09-29，10-01 修订）。
 *
 * # 为什么独立成 hook
 *
 * 桌面侧栏卡、出示屏、手机出示态三处都要同一套规则。写成三份的话，
 * 「收起后要不要清会话」这种细节必然在其中一两处走偏——而走偏的表现是
 * 用户回来点「重新出示」看到一枚新码，已经发给对方的那枚作废，两边对不上。
 *
 * # 两个窗口分开
 *
 * | 窗口 | 取值 | 归谁管 |
 * |---|---|---|
 * | 自动收起 | 见下 | 本 hook（纯前端） |
 * | 有效期 | 3 分钟（会合码）/ 5 分钟（凭证） | 后端 expires_at |
 *
 * # 自动收起策略（2026-10-01 真机联调用户拍板修订）
 *
 * - **会合码（桌面侧栏卡 / 手机出示态）：默认亮码、常驻不自动收**
 *   （`autoHideMs: null`）——对方就站在旁边等着输/扫，先点一次「出示」
 *   是纯摩擦；隐私由「收起」按钮兜底，有效期到了照样换代作废。
 * - **长期凭证（出示屏）：保留 亮 60 秒自动收回**——那是 128 位设备身份，
 *   照抄即全部，值得多一层。
 *
 * 收起**只收回显示**，不清会话、不换码：用户 alt-tab 去手机拿码、锁屏解锁
 * 回来，点「重新出示」看到的仍是同一枚码（未过期），不会整轮重来。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { rcShortPairCode } from "@/lib/api/rc";
import { logger } from "@/lib/logger";

/** 亮码自动收回的默认时长（长期凭证在用）。 */
export const PAIR_CODE_VISIBLE_MS = 60_000;

export type PairCodeVisibility = "masked" | "shown";

export function usePairCodeVisibility(opts?: {
  pinHeld?: boolean;
  /** 自动收起毫秒数；`null` = 常驻亮码不自动收（会合码在用）。缺省 60 秒。 */
  autoHideMs?: number | null;
}) {
  const [vis, setVis] = useState<PairCodeVisibility>("masked");
  const hideTimer = useRef<number | undefined>(undefined);
  /** 会合进行中读最新值：effect 不必因它重排，hide 时判一次就够。 */
  const pinHeldRef = useRef(opts?.pinHeld ?? false);
  pinHeldRef.current = opts?.pinHeld ?? false;
  const autoHideRef = useRef<number | null>(opts?.autoHideMs === undefined ? PAIR_CODE_VISIBLE_MS : opts.autoHideMs);
  autoHideRef.current = opts?.autoHideMs === undefined ? PAIR_CODE_VISIBLE_MS : opts.autoHideMs;

  const clearHide = useCallback(() => {
    if (hideTimer.current) window.clearTimeout(hideTimer.current);
    hideTimer.current = undefined;
  }, []);

  /** 亮码。自动收起到点时若仍在会合（pinHeld），不收。 */
  const show = useCallback(() => {
    clearHide();
    setVis("shown");
    if (autoHideRef.current === null) return;
    hideTimer.current = window.setTimeout(() => {
      hideTimer.current = undefined;
      if (!pinHeldRef.current) setVis("masked");
    }, autoHideRef.current);
  }, [clearHide]);

  const hide = useCallback(() => {
    clearHide();
    setVis("masked");
  }, [clearHide]);

  useEffect(() => clearHide, [clearHide]);

  return { vis, show, hide };
}

/** 到期剩余 → `m:ss`。给读秒用；不规范负值（过期显示 0:00）。 */
export function formatCountdown(ms: number): string {
  const total = Math.max(0, Math.ceil(ms / 1000));
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * 读秒 hook：每 250ms 推一次当前剩余毫秒。没有 expiresAt 就不跑。
 *
 * 🔴 返回 `[remain, ready]`，`ready` = 「这一轮倒计时是否已按当前 expiresAt
 * 初始化过」。调用方判「是否已过期」必须同时看它：`expiresAt` 刚被 setState
 * 写进来的那一帧，`remain` 还是上一个 expiresAt 的旧值（本 hook 的 effect
 * 尚未跑），此时 `remain <= 0` 会把「新码」误判成「已过期」——调用方跟着
 * 就去换一枚新码，用户刚出示的码被换掉。多返回一个布尔让调用方能挡掉这一帧。
 */
export function useCountdown(expiresAt: number | 0): [number, boolean] {
  const [remain, setRemain] = useState(() => (expiresAt ? Math.max(0, expiresAt - Date.now()) : 0));
  const [ready, setReady] = useState(false);
  useEffect(() => {
    if (!expiresAt) {
      setReady(false);
      return;
    }
    // 同步重算一次：不等下一个 tick，否则首帧 remain 是旧值
    const tick = () => setRemain(Math.max(0, expiresAt - Date.now()));
    tick();
    setReady(true);
    const t = window.setInterval(tick, 250);
    return () => {
      window.clearInterval(t);
      setReady(false);
    };
  }, [expiresAt]);
  return [remain, ready];
}

/** 到期换新的一次性提示：换码那一刻置 true，用户任一动作后消。 */
export function useOneShotNotice() {
  const [shown, setShown] = useState(false);
  const fired = useRef(false);
  /** 码换代时调用。同一代只响一次。 */
  const fire = useCallback(() => {
    if (fired.current) return;
    fired.current = true;
    setShown(true);
  }, []);
  const dismiss = useCallback(() => setShown(false), []);
  return { shown, fire, dismiss };
}

/**
 * useOwnPairCode — 出示方那一枚 8 位码的取用与到期换新（桌面侧栏卡 + 手机出示态共用）。
 *
 * 码**只从后端取**（`rcShortPairCode`，均匀随机；10 位十进制拒绝尾部余数保证
 * 等概率）——绝不留给用户手敲：手敲的「12345678」/生日实际熵远低于 27 bit，
 * 会合通道的认证强度就不成立。
 *
 * 到期**换新不延命**：旧码即使被人抄走也不能再用。换代时**不动遮罩态**——
 * 用户正看着屏时把新码藏起来，比让他多看 60 秒更糟（遮罩态则继续遮着，
 * 自动换代不该把明文亮出来）。
 *
 * 可见 60 秒收缴归 `usePairCodeVisibility`，本 hook 只管码本身。
 */
export function useOwnPairCode(opts: {
  /** 亮码（`usePairCodeVisibility` 的 show）。取到新码后调用。 */
  show: () => void;
  /** 取到一枚新码时的界面提示。换代是静默的（只弹一次性提示条，不打扰）。 */
  onFresh?: () => void;
  /** 取码失败（网络 / 后端）。 */
  onError: (error: unknown) => void;
}) {
  const [ownCode, setOwnCode] = useState("");
  const [expiresAt, setExpiresAt] = useState(0);
  const [remain, countdownReady] = useCountdown(expiresAt);
  /** 到期换新的一次性提示。`fire` 由 useCallback 保证引用稳定——直接拿 hook
      返回的对象当依赖会让每次渲染都变（见下方 fetch 的依赖）。 */
  const rotated = useOneShotNotice();
  const rotatedFire = rotated.fire;
  /** 🔴 换代判断用 **ref** 读当前码，不放 setState updater 里：updater 是渲染期
      回调，在里面再调 setState 会形成「变更 → 重渲染 → 再变更」的链，React 下
      表现为取码被反复触发。 */
  const ownCodeRef = useRef("");
  // 三个回调用 ref 转发：调用方多半是内联箭头（每次渲染新引用），直接进依赖
  // 会让 fetch 每次渲染都变，进而在下方 effect 里反复重取。
  const showRef = useRef(opts.show);
  showRef.current = opts.show;
  const onFreshRef = useRef(opts.onFresh);
  onFreshRef.current = opts.onFresh;
  const onErrorRef = useRef(opts.onError);
  onErrorRef.current = opts.onError;

  /** 取一枚码。`silent` = 到期自动换代（不弹「已生成」那类提示）。 */
  const fetch = useCallback(
    async (silent: boolean) => {
      try {
        const r = await rcShortPairCode();
        if (ownCodeRef.current && ownCodeRef.current !== r.code) rotatedFire();
        ownCodeRef.current = r.code;
        setOwnCode(r.code);
        setExpiresAt(r.expires_at);
        if (!silent) onFreshRef.current?.();
        return true;
      } catch (error) {
        logger.warn("取配对码失败", error);
        onErrorRef.current(error);
        return false;
      }
    },
    [rotatedFire],
  );

  /** 出示：未过期就复用同一枚（别把已发出去的换掉），否则取一枚新的再亮。 */
  const reveal = useCallback(async () => {
    if (ownCode && expiresAt > Date.now()) {
      showRef.current();
      return;
    }
    // 取码失败就不亮：亮一枚空的/旧的只会让人以为出了 bug
    if (await fetch(false)) showRef.current();
  }, [ownCode, expiresAt, fetch]);

  /**
   * 到期换新。三重防护，少一重就会变成「刷换码接口」：
   *  ① 判据用 `isExpired` **布尔**而不是 `remain` 毫秒数（后者每 250ms 一变）；
   *  ② `countdownReady`——`expiresAt` 刚 setState 进来的那一帧 `remain` 还是旧值，
   *     会把新码误判成已过期（见 `useCountdown` 的注释）；
   *  ③ 同一个 `expiresAt` 只换一次码——倒计时 effect 因 cleanup 重跑会让
   *     `isExpired` 假性翻转。
   */
  const expired = countdownReady && expiresAt > 0 && remain <= 0;
  const handledExpiryRef = useRef(0);
  useEffect(() => {
    if (!expired || handledExpiryRef.current === expiresAt) return;
    handledExpiryRef.current = expiresAt;
    void fetch(true);
  }, [expired, expiresAt, fetch]);

  return { ownCode, remain, countdownReady, expired, rotated, reveal, fetch };
}
