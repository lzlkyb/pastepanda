import { useEffect, useId, useState, type RefObject } from "react";
import { ChevronRight, Monitor, ScanLine, Smartphone } from "lucide-react";
import { formatShortCode } from "@/lib/rcShortCode";
import { formatCountdown, useOwnPairCode, usePairCodeVisibility } from "@/hooks/usePairCodeVisibility";
import { useMobileBack } from "../ui/useMobileBack";
import { MobileNotice } from "../ui/MobileNotice";
import { RcScanOverlay } from "./RcScanOverlay";
import { RcShowQr } from "./RcShowQr";
import { useMobilePairing } from "./useMobilePairing";
import styles from "./RcPair.module.css";

export function RcPairCard({ onPaired, initialDraft = "", onDraftChange, backRef }: {
  onPaired: (name: string) => void;
  backRef?: RefObject<(() => boolean) | null>;
  initialDraft?: string;
  onDraftChange?: (draft: string) => void;
}) {
  const pairing = useMobilePairing(onPaired, initialDraft);
  useEffect(() => { onDraftChange?.(pairing.peerInput); }, [pairing.peerInput, onDraftChange]);
  const [scanning, setScanning] = useState(false);
  const [revealing, setRevealing] = useState(false);
  const inputId = useId();
  const hintId = useId();
  // 本机码按需取用；出示后常驻，到期静默换新，与桌面端同一规则。
  const { vis, show, hide } = usePairCodeVisibility({ autoHideMs: null });
  const { ownCode, remain, expired, reveal } = useOwnPairCode({ show, onError: pairing.reportError });
  const back = () => {
    if (scanning) { setScanning(false); return true; }
    if (pairing.busy) { void pairing.cancelPair(); return true; }
    if (vis === "shown") { hide(); return true; }
    return false;
  };
  useMobileBack(scanning || vis === "shown" || pairing.busy, back, true, 20);
  useEffect(() => { if (backRef) backRef.current = back; return () => { if (backRef) backRef.current = null; }; });
  const showOwnCode = async () => {
    if (revealing) return;
    setRevealing(true);
    pairing.clearNotice();
    try {
      await reveal();
    } finally {
      setRevealing(false);
    }
  };
  const notice = pairing.notice && (
    <MobileNotice
      tone={pairing.notice.tone}
      title={pairing.notice.tone === "error" ? "配对未能完成" : pairing.notice.text}
      detail={pairing.notice.tone === "error" ? pairing.notice.text : undefined}
    />
  );

  if (pairing.busy) {
    const cancelling = pairing.phase === "cancelling";
    return (
      <div className={styles.card}>
        <div className={styles.pendingHero}>
          <span className={styles.pendingIcon}>
            <Monitor size={32} aria-hidden="true" />
          </span>
          <h2>{cancelling ? "正在取消配对" : "正在完成配对"}</h2>
          <p>
            {pairing.listening
              ? "请在电脑端输入本机配对码，保持此页面打开。"
              : "请保持电脑端配对码页面打开，连接完成后会自动返回。"}
          </p>
        </div>
        {pairing.notice && <MobileNotice tone="pending">{pairing.notice.text}</MobileNotice>}
        <button
          type="button"
          className={styles.secondary}
          disabled={cancelling}
          onClick={() => void pairing.cancelPair()}
        >
          {cancelling ? "正在取消…" : "取消配对"}
        </button>
      </div>
    );
  }
  if (scanning)
    return (
      <RcScanOverlay
        onFound={(text) => {
          pairing.onScanned(text);
          setScanning(false);
        }}
        onClose={() => setScanning(false)}
      />
    );

  if (vis === "shown" && ownCode && !expired)
    return (
      <div className={styles.card}>
        <div className={styles.ownIntro}>
          <h2>在电脑端输入这枚码</h2>
          <p>也可以扫描下方二维码，仅用于设备配对。</p>
        </div>
        <div className={styles.ownCode}>
          <span className={styles.bigCode} role="group" aria-label="我的配对码">
            {formatShortCode(ownCode)}
          </span>
          <span className={`${styles.ttl} ${remain <= 60_000 ? styles.ttlHot : ""}`}>
            有效期 {formatCountdown(remain)}
          </span>
        </div>
        <RcShowQr code={ownCode} />
        <p className={styles.hint}>请让电脑扫码或输入配对码，再点「等待对方连接」。</p>
        <button type="button" className={styles.primary} onClick={() => void pairing.begin(ownCode, true)}>
          等待对方连接
        </button>
        {notice}
        <button type="button" className={styles.secondary} onClick={hide}>
          隐藏配对码
        </button>
      </div>
    );

  return (
    <div className={styles.card}>
      <p className={styles.intro}>
        在电脑端打开<strong>配对码页面</strong>，扫码或输入 8 位码即可添加。
      </p>
      <button type="button" className={styles.scanEntry} onClick={() => setScanning(true)}>
        <ScanLine size={32} aria-hidden="true" />
        <span>
          <strong>扫一扫添加</strong>
          <small>扫描电脑上的配对二维码</small>
        </span>
        <ChevronRight size={20} aria-hidden="true" />
      </button>
      <div className={styles.divider}>
        <span>或输入配对码</span>
      </div>
      <form
        className={styles.form}
        onSubmit={(event) => {
          event.preventDefault();
          void pairing.begin();
        }}
      >
        <label htmlFor={inputId}>电脑的配对码</label>
        <input
          id={inputId}
          className={styles.codeInput}
          aria-describedby={hintId}
          inputMode="numeric"
          enterKeyHint="done"
          autoComplete="off"
          maxLength={12}
          value={pairing.peerInput}
          placeholder="输入 8 位配对码"
          onChange={(event) => pairing.editInput(event.target.value)}
          onBlur={() => {
            if (pairing.peerCode) pairing.editInput(formatShortCode(pairing.peerCode));
          }}
        />
        <p id={hintId} className={styles.hint}>
          输入电脑上显示的码，支持粘贴。
        </p>
        <button type="submit" className={styles.primary} disabled={!pairing.peerCode}>
          开始配对
        </button>
      </form>
      {notice}
      <button type="button" className={styles.ownEntry} disabled={revealing} onClick={() => void showOwnCode()}>
        <Smartphone size={20} aria-hidden="true" />
        <span>{revealing ? "正在生成本机配对码…" : "出示本机配对码"}</span>
        <ChevronRight size={18} aria-hidden="true" />
      </button>
    </div>
  );
}
