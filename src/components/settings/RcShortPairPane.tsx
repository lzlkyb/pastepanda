import { useEffect, useRef, useState } from "react";
import { Copy, ClipboardPaste, RefreshCw } from "lucide-react";
import { readClipboardText } from "@/lib/api";
import { formatShortCode, shortCodeFromInput } from "@/lib/rcShortCode";
import { formatCountdown, useOwnPairCode } from "@/hooks/usePairCodeVisibility";
import { useRcShortPair } from "@/hooks/useRcShortPair";
import { RcShortCodeQr } from "@/components/rc/RcShortCodeQr";
import type { ToastFn } from "@/components/Toast";
import styles from "./RcConnect.module.css";

export function RcShortPairPane({ scan, toast, onPaired }: {
  scan: boolean; toast: ToastFn; onPaired: (id: string, name: string) => void;
}) {
  const [showOwn, setShowOwn] = useState(scan);
  const [input, setInput] = useState("");
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const pair = useRcShortPair(onPaired);
  const own = useOwnPairCode({ show: () => {}, onError: (e) => setError(`获取配对码失败：${String(e)}`) });
  const fetched = useRef(false);
  const reveal = own.reveal;
  useEffect(() => {
    if (!showOwn || fetched.current) return;
    fetched.current = true;
    setLoading(true);
    void reveal().finally(() => setLoading(false));
  }, [showOwn, reveal]);

  const { begin, cancel } = pair;
  useEffect(() => {
    if (!showOwn || !own.ownCode || own.expired) return;
    // 延后一帧让 StrictMode 的探测挂载先结束，避免重复注册同一枚会合码。
    const timer = window.setTimeout(() => void begin(own.ownCode, true), 0);
    return () => { window.clearTimeout(timer); void cancel(); };
  }, [showOwn, own.ownCode, own.expired, begin, cancel]);

  const paste = async () => {
    try {
      const parsed = shortCodeFromInput(await readClipboardText());
      if (!parsed) { setError("剪贴板里没有有效的 8 位配对码，请手动输入。"); return; }
      setInput(parsed); setError("");
    } catch { setError("无法读取剪贴板，请手动输入配对码。"); }
  };
  const refresh = async () => {
    setLoading(true); setError("");
    await cancel();
    // 未过期时复用后端同一枚码，避免把已发给对方的码作废。
    if (own.ownCode && !own.expired) void begin(own.ownCode, true);
    else await own.fetch(false);
    setLoading(false);
  };
  const parsed = shortCodeFromInput(input);
  return (
    <div>
      {!scan && <div className={styles.codeModes}>
        <button type="button" aria-pressed={!showOwn} onClick={() => { void cancel(); setShowOwn(false); setError(""); }}>输入对方配对码</button>
        <button type="button" aria-pressed={showOwn} onClick={() => { void cancel(); setShowOwn(true); setError(""); }}>出示本机配对码</button>
      </div>}
      {showOwn ? <div className={styles.hero}>
        <h3>{scan ? "用手机扫一扫，连接这台电脑" : "让对方输入这枚配对码"}</h3>
        <p className={styles.hint}>{scan ? "打开手机端 PastePanda，在添加设备中选择扫一扫。" : "对方打开添加设备，选择配对码并输入下方数字。"}</p>
        {own.ownCode && !own.expired && <>
          {scan && <div className={styles.qr}><RcShortCodeQr code={own.ownCode} size={216} onError={() => setError("二维码暂时无法显示，请让对方输入下方 8 位配对码。")} /></div>}
          <div className={styles.digits}>{formatShortCode(own.ownCode)}</div>
          <div className={styles.ttl}>有效期 {formatCountdown(own.remain)} · 到期自动更新</div>
        </>}
        {loading && <p className={styles.hint} role="status">正在获取配对码…</p>}
        <div className={styles.actions}>
          <button type="button" className={styles.button} disabled={!own.ownCode || own.expired} onClick={() => {
            void navigator.clipboard.writeText(own.ownCode).then(() => toast("配对码已复制", "success"), () => toast("复制失败，请手动复制配对码", "error"));
          }}><Copy size={14} />复制配对码</button>
          <button type="button" className={styles.button} disabled={loading} onClick={() => void refresh()}><RefreshCw size={14} />重新等待</button>
        </div>
      </div> : <form onSubmit={(event) => { event.preventDefault(); if (parsed && !pair.busy) { setError(""); void begin(parsed, false); } }}>
        <h3>输入对方的 8 位配对码</h3>
        <p className={styles.hint}>让对方在添加设备中选择“出示本机配对码”，并保持该页面打开。</p>
        <label htmlFor="rc-peer-code" className={styles.label}>对方配对码</label>
        <input id="rc-peer-code" className={styles.input} inputMode="numeric" autoComplete="off" maxLength={16} value={input}
          placeholder="例如 1234 5678" disabled={pair.busy} onChange={(event) => { setInput(event.target.value); setError(""); }} />
        <div className={styles.actions}>
          <button type="button" className={styles.button} disabled={pair.busy} onClick={() => void paste()}><ClipboardPaste size={14} />粘贴配对码</button>
          <button type="submit" className={styles.primary} disabled={!parsed || pair.busy}>{pair.busy ? "正在配对…" : "确认配对"}</button>
        </div>
      </form>}
      {(error || pair.message) && <div className={`${styles.status} ${error || pair.phase === "error" ? styles.error : ""}`} role={error || pair.phase === "error" ? "alert" : "status"}>
        <span>{error || pair.message}</span>
        {pair.busy && <button type="button" className={styles.button} onClick={() => void cancel()}>取消</button>}
      </div>}
    </div>
  );
}
