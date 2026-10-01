/**
 * RcPairCard — 配对卡：短码互输（与桌面 RcA2PairExchange 同一条流）。
 *
 * 时序（抄桌面实现，规则 12）：rcShortPairCode 出自己的 8 位码（带过期，
 * 到期自动换新并提示）→ 对方码 shortCodeFromInput 识别（接受 PP- 粘贴）→
 * rcPinPairBegin(own, listen) → 5s 轮询 rcExchangeCheck 至 paired →
 * onPaired。离开 joining/waiting 必 rcShortPairCancel（桌面同款卸载纪律）。
 *
 * 手机是「有摄像头、键盘烂」的一端：默认走输入态（输入框 + 扫一扫），码由
 * 电脑端出示。出示态与桌面同款（2026-10-01 联调拍板）：默认收起、点「出示」
 * 亮出后**常驻**不自动收、到期自动换新；出示时手机是 listen 方。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { rcExchangeCheck, rcPinPairBegin, rcShortPairCancel } from "@/lib/api/rc";
import { formatShortCode, shortCodeFromClipboard, shortCodeFromInput } from "@/lib/rcShortCode";
import { RcScanOverlay } from "./RcScanOverlay";
import { RcShowQr } from "./RcShowQr";
import { formatCountdown, useOwnPairCode, usePairCodeVisibility } from "@/hooks/usePairCodeVisibility";
import { rcErrorText } from "./rcErrorText";
import styles from "./RcDevices.module.css";

type PairPhase = "idle" | "joining" | "waiting" | "paired" | "error";
type Notice = { tone: "info" | "success" | "error"; text: string } | null;

export function RcPairCard({
  onClose,
  onPaired,
}: {
  onClose: () => void;
  /** 配对成功（父级刷新设备列表并收卡）。 */
  onPaired: (name: string) => void;
}) {
  const [peerInput, setPeerInput] = useState("");
  const [phase, setPhase] = useState<PairPhase>("idle");
  const [notice, setNotice] = useState<Notice>(null);
  /** 「扫一扫」浮层开着没有。摄像头只在开着的时候拿帧（见 useQrScan 头注释）。 */
  const [scanning, setScanning] = useState(false);
  /**
   * 会合进行中（join/waiting）：两端都在等对方。按钮态与取消逻辑在用。
   * 亮码策略与桌面同款：autoHideMs=null 常驻亮码（2026-10-01 联调拍板），
   * 「收起」按钮兜隐私。
   */
  const busy = phase === "joining" || phase === "waiting";
  const { vis, show: showCode, hide: hideCode } = usePairCodeVisibility({ autoHideMs: null });
  /** 出示方向：后端生成的码（空 = 还没出示过 / 到期未换）。到期静默换新。 */
  const { ownCode, remain, expired, reveal } = useOwnPairCode({
    show: showCode,
    onError: (e) => setNotice({ tone: "error", text: rcErrorText(e) }),
  });
  const phaseRef = useRef(phase);
  phaseRef.current = phase;

  const peerIdRef = useRef("");
  const peerNameRef = useRef("");

  // waiting：5s 轮询直至 paired（与桌面同节拍）
  useEffect(() => {
    if (phase !== "waiting" || !peerIdRef.current) return;
    let cancelled = false;
    let timer: number | undefined;
    const check = async () => {
      try {
        const state = await rcExchangeCheck(peerIdRef.current);
        if (cancelled) return;
        if (state === "paired") {
          setPhase("paired");
          setNotice({ tone: "success", text: `已与「${peerNameRef.current}」配对。` });
          onPaired(peerNameRef.current);
          return;
        }
      } catch (e) {
        if (cancelled) return;
        setPhase("error");
        setNotice({ tone: "error", text: rcErrorText(e) });
        return;
      }
      timer = window.setTimeout(() => void check(), 5000);
    };
    void check();
    return () => {
      cancelled = true;
      if (timer) window.clearTimeout(timer);
    };
  }, [phase, onPaired]);

  // 卸载兜底：加入/等待中离开 = 取消配对尝试（桌面同纪律）
  useEffect(() => {
    const ph = phaseRef;
    return () => {
      if (ph.current === "joining" || ph.current === "waiting") void rcShortPairCancel();
    };
  }, []);

  // 🔴 手机端固定是**输入方**（listen = false）：出示方在电脑上。这个布尔写死，
  //    不暴露给用户选——选反了表现是永远连不上，而在现场没有任何线索可查。
  const begin = useCallback(async (listen = false) => {
    const code = listen ? ownCode : shortCodeFromInput(peerInput);
    if (!code) return;
    setPhase("joining");
    setNotice({ tone: "info", text: listen ? "已出示，正在等对方输入这枚码…" : "正在等电脑端也确认配对…" });
    try {
      const peer = await rcPinPairBegin(code, listen);
      peerIdRef.current = peer.node_id;
      peerNameRef.current = peer.name;
      setPhase("waiting");
      setNotice({ tone: "info", text: `已找到「${peer.name}」，正在完成双方确认…` });
    } catch (e) {
      if (String(e).includes("已取消配对")) {
        setPhase("idle");
        setNotice({ tone: "info", text: "已取消配对。" });
      } else {
        setPhase("error");
        setNotice({ tone: "error", text: `未能配对：${rcErrorText(e)}` });
      }
    }
  }, [peerInput, ownCode]);

  const cancelPair = useCallback(async () => {
    await rcShortPairCancel().catch(() => {});
    setPhase("idle");
    setNotice({ tone: "info", text: "已取消配对。" });
  }, []);

  const peerCode = shortCodeFromInput(peerInput);

  /**
   * 扫到了什么。两条入口都认：带 `PP-` 的二维码载荷（`shortCodeFromClipboard`），
   * 以及人手敲的 8 位 / 4+4（`shortCodeFromInput`）。🔴 只调 `shortCodeFromInput`
   * 是个坑：它剥空格横线但**不剥 `PP` 前缀**，扫自己出示的二维码会当场判
   * 「不是配对码」——守卫测试 `RcPairScan.test.tsx` 钉着这条。
   */
  const onScanned = useCallback((text: string) => {
    const code = shortCodeFromClipboard(text) ?? shortCodeFromInput(text);
    setScanning(false);
    if (!code) {
      setNotice({ tone: "error", text: "扫到的不是配对码（应是 PP-XXXX-XXXX 或 8 位数字）。" });
      return;
    }
    setPeerInput(code);
    if (phase === "error") setPhase("idle");
    setNotice({ tone: "success", text: "已识别对方的配对码，点「开始配对」即可。" });
  }, [phase]);

  if (phase === "waiting") {
    return (
      <div className={styles.pairCard}>
        <div className={styles.pendingTitle}>
          <span className={styles.spin} /> 正在等双方确认…
        </div>
        <div className={styles.pendingSub}>
          电脑端也在输入你这串码。对方确认后这里会自动跳。
        </div>
        <button type="button" className={styles.ghostBtn} onClick={() => void cancelPair()}>
          取消配对
        </button>
        {notice && <div role="status" className={`${styles.notice} ${notice.tone === "error" ? styles.noticeError : notice.tone === "success" ? styles.noticeSuccess : ""}`}>{notice.text}</div>}
      </div>
    );
  }

  if (scanning) {
    return (
      <div className={styles.pairCard}>
        <RcScanOverlay onFound={onScanned} onClose={() => setScanning(false)} />
      </div>
    );
  }

  /** 出示态：码值 + 读秒 + 二维码（三个形态指向同一枚码）。到期就不亮——
      旧码已作废，亮着只会让对方拿着它去连然后失败。 */
  if (vis === "shown" && ownCode && !expired) {
    return (
      <div className={styles.pairCard}>
        <div className={styles.pairHint}>把这枚码输到要连你的那一端</div>
        <div className={styles.codeBar}>
          <span className={styles.bigCode} role="group" aria-label="我的配对码">
            {formatShortCode(ownCode)}
          </span>
          <span className={`${styles.ttl} ${remain <= 60_000 ? styles.ttlHot : ""}`}>
            {formatCountdown(remain)}
          </span>
          <button type="button" className={styles.ghostBtn} onClick={hideCode}>收起</button>
        </div>
        <div className={styles.codeExp}>码常驻亮出 · 点「收起」可隐藏，再点「出示」还是同一枚 · 到期自动换新</div>
        <RcShowQr code={ownCode} />
        {/* 🔴 listen = true：出示方是本机监听、对端来拨。写成默认参数就变成拿
            peerInput 去拨（多半是空的）——按钮点了没反应，现场没有任何线索。 */}
        <button
          type="button"
          className={styles.primaryBtn}
          disabled={busy}
          onClick={() => void begin(true)}
        >
          {busy ? "等待中" : "我出示这枚码（等对方来连）"}
        </button>
        <button type="button" className={styles.ghostBtn} onClick={onClose}>收起</button>
        {notice && (
          <div
            role={notice.tone === "error" ? "alert" : "status"}
            className={`${styles.notice} ${notice.tone === "error" ? styles.noticeError : notice.tone === "success" ? styles.noticeSuccess : ""}`}
          >
            {notice.text}
          </div>
        )}
      </div>
    );
  }

  return (
    <div className={styles.pairCard}>
      {/* 遮罩不是空着：明说这里有一颗码但没亮。 */}
      <div className={`${styles.codeBar} ${styles.codeBarMasked}`}>
        <span className={styles.maskedLabel}>
          {expired ? "配对码已过期，已自动换新" : "配对码已收起"}
        </span>
        <button type="button" className={styles.ghostBtn} disabled={busy} onClick={() => void reveal()}>
          出示
        </button>
      </div>
      {/* 到期静默换代（与桌面同款拍板：不弹文字提醒）；过期痕迹只剩遮罩条上的那句话 */}
      <div className={styles.pairHint}>输入电脑上出示的那枚 8 位配对码，或点「出示」生成一枚给对方</div>
      <input
        className={styles.codeInput}
        aria-label="对方的配对码"
        inputMode="numeric"
        maxLength={12}
        value={peerInput}
        placeholder="输入电脑上显示的 8 位码"
        onChange={(e) => {
          setPeerInput(e.target.value);
          if (phase === "error") setPhase("idle");
        }}
      />
      <button
        type="button"
        className={styles.ghostBtn}
        disabled={busy}
        onClick={() => setScanning(true)}
      >
        扫一扫（扫对方的码）
      </button>
      <button
        type="button"
        className={styles.primaryBtn}
        disabled={!peerCode || busy}
        onClick={() => void begin(false)}
      >
        开始配对
      </button>
      <button type="button" className={styles.ghostBtn} onClick={onClose}>
        收起
      </button>
      {notice && (
        <div
          role={notice.tone === "error" ? "alert" : "status"}
          className={`${styles.notice} ${notice.tone === "error" ? styles.noticeError : notice.tone === "success" ? styles.noticeSuccess : ""}`}
        >
          {notice.text}
        </div>
      )}
    </div>
  );
}
