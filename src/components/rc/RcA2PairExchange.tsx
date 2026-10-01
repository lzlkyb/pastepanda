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
  /** 会合进行中（join/waiting）。两端都在等对方；按钮态与取消逻辑在用。 */
  const busy = phase === "joining" || phase === "waiting";
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
   */
  const begin = async (listen: boolean) => {
    const code = listen ? ownCode : shortCodeFromInput(peerCode);
    if (!code) return;
    setPhase("joining");
    setNotice({ tone: "info", text: listen ? "已出示，正在等对方输入这枚码…" : "正在等待对方也确认配对…" });
    try {
      const peer = await rcPinPairBegin(code, listen);
      setPeerId(peer.node_id);
      setPeerName(peer.name);
      setPhase("waiting");
      setNotice({ tone: "info", text: `已找到「${peer.name}」，正在完成双方确认…` });
    } catch (error) {
      if (String(error).includes("已取消配对")) {
        setPhase("idle");
        setNotice({ tone: "info", text: "已取消配对。" });
      } else {
        setPhase("error");
        setNotice({ tone: "error", text: `未能配对：${String(error)}` });
      }
    }
  };

  const parsed = shortCodeFromInput(peerCode);
  const ttlHot = remain > 0 && remain <= 60_000;
  const shown = vis === "shown" && !expired;

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
            disabled={busy}
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
        {/* 两个入口各自固定 listen 角色，不给用户选（见 begin 的注释）。 */}
        <button
          type="button"
          className={styles.pairPrimary}
          disabled={!shown || !ownCode || busy}
          onClick={() => void begin(true)}
        >
          {busy ? "等待中" : "我出示这枚码"}
        </button>
        <button
          type="button"
          className={styles.pairSecondary}
          disabled={!parsed || busy}
          onClick={() => void begin(false)}
        >
          {busy ? "等待中" : "对方给我这枚码"}
        </button>
      </div>
      <div className={styles.pairFeedback}>
        {notice && <div role={notice.tone === "error" ? "alert" : "status"} className={notice.tone === "error" ? styles.pairNoticeError : notice.tone === "success" ? styles.pairNoticeSuccess : styles.pairNotice}>
          <span>{notice.text}</span>
          {phase === "joining" && <button type="button" className={styles.pairCancel} onClick={() => void rcShortPairCancel()}>取消</button>}
        </div>}
        {!notice && <span className={styles.pairHint}>
          {shown
            ? "对方扫码或输同一枚码后，点「我出示这枚码」接通"
            : "点「出示」重新亮码；要连你的那一端输同一枚码或扫码"}
        </span>}
      </div>
    </div>
  );
}
