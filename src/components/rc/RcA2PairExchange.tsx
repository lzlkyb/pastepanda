import { useEffect, useRef, useState } from "react";
import { readClipboardText } from "@/lib/api";
import { rcExchangeCheck, rcPinPairBegin, rcShortPairCancel } from "@/lib/api/rc";
import { formatShortCode, shortCodeFromClipboard, shortCodeFromInput } from "@/lib/rcShortCode";
import { useWindowVisible } from "@/hooks/useWindowVisible";
import { formatCountdown, useOwnPairCode, usePairCodeVisibility } from "@/hooks/usePairCodeVisibility";
import type { UseRc } from "@/hooks/useRc";
import type { ToastFn } from "@/components/Toast";
import { RcShortCodeQr } from "./RcShortCodeQr";
import styles from "./RemoteComputerA2.module.css";

type Notice = { tone: "info" | "success" | "error"; text: string } | null;

/**
 * 单枚 8 位码会合屏（2026-09-29，10-01 联调修订）。
 *
 * 出示方那半边的码由**后端生成**（`rcShortPairCode`，均匀随机；10 位十进制
 * 拒绝尾部余数保证等概率）——绝不留给用户手敲：手敲的「12345678」/生日
 * 实际熵远低于 27 bit，会合通道的认证强度就不成立。
 *
 * 显示策略（2026-10-01 用户拍板）：**进页面即亮码、常驻不自动收**
 * （`autoHideMs: null`）——对方就站在旁边等着扫/输，先点一次「出示」是纯
 * 摩擦；隐私由「收起」按钮兜底，有效期 3 分钟到点照样换代作废。
 * 二维码（`RcShortCodeQr`）随码常驻，手机「扫一扫」直接扫它。
 *
 * `listen` 由入口固定：出示方 true、输入方 false，不暴露给用户选——
 * 选反了的表现是永远连不上，现场没有任何线索（规则 11.1）。
 */
export function RcA2PairExchange({ rc, toast }: {
  rc: UseRc;
  toast: ToastFn;
}) {
  const visible = useWindowVisible();
  const [phase, setPhase] = useState<"idle" | "joining" | "waiting" | "paired" | "error">("idle");
  const [notice, setNotice] = useState<Notice>(null);
  const { vis, show: showCode, hide: hideCode } = usePairCodeVisibility({ autoHideMs: null });
  /** 出示方那一枚码：后端取、到期静默换新（桌面与手机同一套）。 */
  const { ownCode, remain, expired, reveal } = useOwnPairCode({
    show: showCode,
    onError: (error) => setNotice({ tone: "error", text: `获取配对码失败：${String(error)}` }),
  });
  const [peerCode, setPeerCode] = useState("");
  const [peerId, setPeerId] = useState("");
  const [peerName, setPeerName] = useState("");
  /** 二维码弹框（2026-10-01 用户拍板：默认藏，点了再弹；只在亮码态可开）。 */
  const [qrOpen, setQrOpen] = useState(false);
  const refreshTargets = rc.refreshTargets;

  // 进页面即取码亮出（自动换代沿用 useOwnPairCode 的到期逻辑）。
  const mountedRef = useRef(false);
  useEffect(() => {
    if (mountedRef.current) return;
    mountedRef.current = true;
    void reveal();
  }, [reveal]);

  // 弹框开着时 Esc = 关闭（两级取消：误开成本低）
  useEffect(() => {
    if (!qrOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setQrOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [qrOpen]);

  useEffect(() => {
    if (phase !== "joining") return;
    return () => { void rcShortPairCancel(); };
  }, [phase]);

  // 窗口获焦时只识别带 PP 前缀的码，不在后台监听剪贴板。
  useEffect(() => {
    if (!visible || peerCode || phase === "paired") return;
    let cancelled = false;
    void readClipboardText().then((text) => {
      const code = shortCodeFromClipboard(text);
      if (!cancelled && code) {
        setPeerCode(code);
        setNotice({ tone: "info", text: "已识别对方的配对码，点确认即可配对。" });
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [visible, peerCode, phase]);

  // 🔴 轮询**不能**门在窗口可见性上（2026-09-30 真机实证）：确认是全流程最后
  //    一步，用户会 alt-tab 去手机/浏览器拿码——窗口一隐藏轮询就停，卡片永久
  //    停在「等待中」，而对方其实早已确认完毕。
  useEffect(() => {
    if (!peerId || phase !== "waiting") return;
    let cancelled = false;
    let timer: number | undefined;
    const check = async () => {
      try {
        const state = await rcExchangeCheck(peerId);
        if (cancelled) return;
        if (state === "paired") {
          setPhase("paired");
          setNotice({ tone: "success", text: `已与「${peerName}」配对，设备已加入列表。` });
          setPeerCode("");
          void refreshTargets();
          toast(`已与「${peerName}」配对`, "success");
          return;
        }
      } catch (error) {
        if (cancelled) return;
        setPhase("error");
        setNotice({ tone: "error", text: String(error) });
        return;
      }
      timer = window.setTimeout(() => void check(), 5000);
    };
    void check();
    return () => { cancelled = true; if (timer) window.clearTimeout(timer); };
  }, [peerId, peerName, phase, refreshTargets, toast]);

  /**
   * 发起会合。`listen` 由**入口**固定：出示方 true、输入方 false。
   * 输入方填的是对方出示的那枚码；出示方填的是自己刚生成/看到的这枚。
   * attempt 序号：亮码即监听（见下方 effect）与手动拨号可以互相取代，
   * 落后的回调不得覆盖新操作已经写入的状态。
   */
  const begin = async (listen: boolean) => {
    const code = listen ? ownCode : shortCodeFromInput(peerCode);
    if (!code) return;
    const attempt = ++attemptRef.current;
    setPhase("joining");
    setNotice({ tone: "info", text: listen ? "已出示，正在等对方扫码或输入这枚码…" : "正在等待对方接通…请保持电脑端配对码页面打开" });
    try {
      const peer = await rcPinPairBegin(code, listen);
      if (attempt !== attemptRef.current) return;
      setPeerId(peer.node_id);
      setPeerName(peer.name);
      setPhase("waiting");
      setNotice({ tone: "info", text: `已找到「${peer.name}」，正在完成双方确认…` });
    } catch (error) {
      if (attempt !== attemptRef.current) return;
      if (String(error).includes("已取消配对")) {
        setPhase("idle");
        setNotice({ tone: "info", text: "已取消配对。" });
      } else {
        setPhase("error");
        setNotice({ tone: "error", text: `未能配对：${String(error)}` });
      }
    }
  };

  // 稳定的操作句柄（begin 每次渲染重建，放进 effect 依赖会导致定时器反复重挂）。
  const beginRef = useRef(begin);
  beginRef.current = begin;
  /** 异步操作序号：旧的 begin 落后回来时不许覆盖新操作的状态（真机教训：
      自动监听被拨号取代后，旧任务的「已取消配对」会把拨号中的界面打回 idle）。 */
  const attemptRef = useRef(0);
  const phaseRef = useRef(phase);
  phaseRef.current = phase;
  const parsed = shortCodeFromInput(peerCode);
  const ttlHot = remain > 0 && remain <= 60_000;
  const shown = vis === "shown" && !expired;

  // 🔴 亮码即监听（2026-10-03 真机教训）：进页面亮码原本只是「把码摆出来」，
  //    手机扫码后什么都不会发生——还得再点一次「我出示这枚码」才开始监听，
  //    扫码方永远停在「等待电脑端确认」（当天公网配对首次联调即卡在这里）。
  //    现在与设置弹框的扫码页（RcShortPairPane）同一语义：码亮着 = 正在出示
  //    = 正在监听。拨号侧开始时取消监听、结束后 phase 回 idle 自动重新挂上。
  /** 当前挂着监听的那枚码（null = 没挂）。收起时靠它取消。 */
  const armedCodeRef = useRef<string | null>(null);
  /** phase 每离开 idle 一次记一代。同代同码只挂一次（防 StrictMode 重复注册）；
      换过代再回 idle 必须重新挂——拨号失败/取消后码还亮着，只按码值去重会让
      「亮着」变成「只是摆着」，手机再扫码又是干等（同一教训的收尾）。 */
  const genRef = useRef(0);
  useEffect(() => {
    // 收起/遮蔽 = 停止出示：取消监听（隐私兜底——码看不见了也不再接新客）。
    // 不作废 attempt：让被取消任务的 catch 把 phase 归位 idle，出示时自动重挂。
    if (!shown) {
      if (armedCodeRef.current) {
        armedCodeRef.current = null;
        void rcShortPairCancel();
      }
      return;
    }
    if (phase !== "idle") {
      genRef.current += 1;
      return;
    }
    if (!ownCode || expired) return;
    const key = `${genRef.current}:${ownCode}`;
    if (armedCodeRef.current === key) return;
    armedCodeRef.current = key;
    // 延后一帧：StrictMode 的探测挂载会先跑一遍 effect，避免重复注册同一枚码。
    const timer = window.setTimeout(() => {
      if (phaseRef.current === "idle") void beginRef.current(true);
    }, 0);
    return () => window.clearTimeout(timer);
  }, [phase, shown, ownCode, expired]);

  return (
    <div className={styles.pairExchange}>
      {/* 出示方那一半：码+读秒一行、动作一行——270px 侧栏塞一行会互相挤压
          （2026-10-01 联调反馈「全部重叠」）。收起按钮保留兜隐私。 */}
      <div className={`${styles.pairCodeBar} ${shown ? "" : styles.pairCodeBarMasked}`}>
        {shown ? (
          <>
            <span className={styles.pairDigits}>{formatShortCode(ownCode)}</span>
            <span className={`${styles.pairTtl} ${ttlHot ? styles.pairTtlHot : ""}`}>
              {formatCountdown(remain)}
            </span>
          </>
        ) : (
          <span className={styles.pairMaskedLabel}>
            {expired ? "配对码已过期，已自动换新" : "配对码已收起"}
          </span>
        )}
      </div>
      <div className={styles.pairCodeActs}>
        {shown ? (
          <>
            {/* 二维码默认藏，点了在弹框里看（手机「扫一扫」扫它） */}
            <button type="button" className={styles.pairGhostSm} onClick={() => setQrOpen(true)}>
              二维码
            </button>
            <button type="button" className={styles.pairGhostSm} onClick={hideCode}>收起</button>
          </>
        ) : (
          <button
            type="button"
            className={styles.pairGhostSm}
            onClick={() => void reveal()}
          >
            出示
          </button>
        )}
      </div>

      {/* 二维码弹框：手机「扫一扫」扫它。码收起/换代作废时跟着关（旧码不值得扫）。 */}
      {qrOpen && shown && (
        <div className={styles.pairQrBackdrop} onClick={() => setQrOpen(false)}>
          <div
            className={styles.pairQrDialog}
            role="dialog"
            aria-label="配对码二维码"
            onClick={(e) => e.stopPropagation()}
          >
            <div className={styles.pairQrTitle}>手机「扫一扫」扫这个码</div>
            <RcShortCodeQr code={ownCode} size={220} />
            <span className={styles.pairQrDigits}>{formatShortCode(ownCode)}</span>
            <button type="button" className={styles.pairGhostSm} onClick={() => setQrOpen(false)}>
              关闭
            </button>
          </div>
        </div>
      )}

      {/* 到期静默换代（2026-10-01 用户拍板：不弹文字提醒，自动刷新就行）——
          界面上唯一的过期痕迹是读秒到 0:00 与新码值。 */}

      <div className={styles.pairPeerRow}>
        <input
          aria-label="对方的配对码"
          inputMode="numeric"
          maxLength={12}
          value={peerCode}
          onChange={(e) => { setPeerCode(e.target.value); if (phase === "error") setPhase("idle"); }}
          placeholder="输入对方的那枚 8 位码"
        />
      </div>
      <div className={styles.pairRoleBtns}>
        {/* 出示侧已自动化（亮码即监听，见上方 effect），这里只剩拨号侧入口。
            点击先取消自动监听再拨号，两条任务不打架；拨号结束后 phase 回
            idle，自动监听会自己重新挂上。 */}
        <button
          type="button"
          className={styles.pairSecondary}
          disabled={!parsed}
          onClick={() => {
            const peer = shortCodeFromInput(peerCode);
            if (!peer) return;
            void (async () => {
              attemptRef.current += 1; // 作废仍在飞的自动监听回调
              await rcShortPairCancel();
              await beginRef.current(false);
            })();
          }}
        >
          {phase === "joining" || phase === "waiting" ? "等待中" : "对方给我这枚码"}
        </button>
      </div>
      <div className={styles.pairFeedback}>
        {notice && <div role={notice.tone === "error" ? "alert" : "status"} className={notice.tone === "error" ? styles.pairNoticeError : notice.tone === "success" ? styles.pairNoticeSuccess : styles.pairNotice}>
          <span>{notice.text}</span>
          {phase === "joining" && <button type="button" className={styles.pairCancel} onClick={() => void rcShortPairCancel()}>取消</button>}
        </div>}
        {!notice && <span className={styles.pairHint}>
          {shown
            ? "码亮着即在等待对方：手机扫码或输同一枚码即可接通"
            : "点「出示」重新亮码；要连你的那一端输同一枚码或扫码"}
        </span>}
      </div>
    </div>
  );
}
