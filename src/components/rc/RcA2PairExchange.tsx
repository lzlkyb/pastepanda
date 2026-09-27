import { useEffect, useState } from "react";
import { readClipboardText } from "@/lib/api";
import { rcExchangeBegin, rcExchangeCheck } from "@/lib/api/rc";
import { useWindowVisible } from "@/hooks/useWindowVisible";
import type { UseRc } from "@/hooks/useRc";
import type { ToastFn } from "@/components/Toast";
import styles from "./RemoteComputerA2.module.css";

type Notice = { tone: "info" | "success" | "error"; text: string } | null;

/** 首页卡片的长期配对：本机码按需生成，双方都粘贴后才显示成功。 */
export function RcA2PairExchange({ rc, enabled, toast }: {
  rc: UseRc;
  enabled: boolean;
  toast: ToastFn;
}) {
  const visible = useWindowVisible();
  const [ownCode, setOwnCode] = useState("");
  const [expiresAt, setExpiresAt] = useState(0);
  const [peerCode, setPeerCode] = useState("");
  const [pasteOpen, setPasteOpen] = useState(false);
  const [peerId, setPeerId] = useState("");
  const [peerName, setPeerName] = useState("");
  const [phase, setPhase] = useState<"idle" | "waiting" | "paired" | "error">("idle");
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<Notice>(null);
  const refreshTargets = rc.refreshTargets;

  // 邀请门可能在页面长时间打开后结束。只排一次到期任务，不做常驻倒计时。
  useEffect(() => {
    if (!expiresAt) return;
    const timer = window.setTimeout(() => {
      setOwnCode("");
      setPhase((current) => current === "paired" ? current : "error");
      setNotice({ tone: "error", text: "本次配对窗口已结束，请重新生成并交换配对码。" });
    }, Math.max(0, expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [expiresAt]);

  useEffect(() => {
    if (!peerId || phase !== "waiting" || !visible) return;
    let cancelled = false;
    let timer: number | undefined;
    const check = async () => {
      try {
        const state = await rcExchangeCheck(peerId);
        if (cancelled) return;
        if (state === "paired") {
          setPhase("paired");
          setNotice({ tone: "success", text: `已与「${peerName}」配对，设备已加入列表。` });
          setOwnCode("");
          setExpiresAt(0);
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
  }, [peerId, peerName, phase, visible, refreshTargets, toast]);

  const copyCode = async () => {
    setBusy(true);
    try {
      const r = await rc.createInvite(rc.identity?.device_name ?? "");
      setOwnCode(r.code);
      setExpiresAt(r.expires_at);
      setPeerId("");
      setPhase("idle");
      try {
        await navigator.clipboard.writeText(r.code);
        setNotice({ tone: "success", text: "配对码已复制。发给对方，请对方也把自己的配对码发给你。" });
      } catch {
        setNotice({ tone: "error", text: "配对码已生成，但复制失败。请选中上方完整码手动复制。" });
      }
    } catch (error) {
      setNotice({ tone: "error", text: `生成配对码失败：${String(error)}` });
    } finally {
      setBusy(false);
    }
  };

  const pasteClipboard = async () => {
    try {
      setPeerCode((await readClipboardText()).trim());
      setNotice(null);
    } catch (error) {
      setNotice({ tone: "error", text: `读取剪贴板失败：${String(error)}` });
    }
  };

  const begin = async () => {
    if (!ownCode || !peerCode.trim()) return;
    setBusy(true);
    try {
      const peer = await rcExchangeBegin(peerCode.trim());
      setPeerId(peer.node_id);
      setPeerName(peer.name);
      setPhase("waiting");
      setNotice({ tone: "info", text: `已收到「${peer.name}」的码，等待对方也粘贴你的码。` });
    } catch (error) {
      setPhase("error");
      setNotice({ tone: "error", text: `未能开始配对：${String(error)}` });
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className={styles.pairExchange}>
      <label className={styles.pairLabel} htmlFor="rc-own-pair-code">我的配对码</label>
      <textarea
        id="rc-own-pair-code"
        className={styles.pairCode}
        rows={3}
        readOnly
        value={ownCode}
        placeholder="点击下方按钮，生成并复制配对码"
        onFocus={(e) => e.currentTarget.select()}
      />
      <button type="button" className={styles.pairPrimary} disabled={busy || !rc.identity || !enabled} onClick={() => void copyCode()}>
        {busy ? "生成中…" : ownCode ? "重新生成并复制配对码" : "生成并复制配对码"}
      </button>
      <div className={styles.pairHint}>{enabled ? "发给对方；本次邀请窗口开放 30 分钟。" : "先开启下方「允许别人连接本机」，再交换配对码。"}</div>
      <button
        type="button"
        className={styles.pairSecondary}
        aria-expanded={pasteOpen}
        onClick={() => setPasteOpen((open) => !open)}
      >
        {pasteOpen ? "收起对方配对码" : "粘贴对方的配对码"}
      </button>
      {pasteOpen && (
        <div className={styles.pairPaste}>
          <label className={styles.pairLabel} htmlFor="rc-peer-pair-code">对方发来的码</label>
          <textarea id="rc-peer-pair-code" rows={3} value={peerCode} onChange={(e) => setPeerCode(e.target.value)} placeholder="在这里粘贴对方的配对码" />
          <div className={styles.pairPasteActions}>
            <button type="button" className={styles.pairSecondary} onClick={() => void pasteClipboard()}>从剪贴板填入</button>
            <button type="button" className={styles.pairPrimary} disabled={busy || !ownCode || !peerCode.trim() || phase === "waiting"} onClick={() => void begin()}>确认交换</button>
          </div>
        </div>
      )}
      <div className={styles.pairHint}>双方都粘贴对方的码，配对才会完成。</div>
      {notice && <div role={notice.tone === "error" ? "alert" : "status"} className={notice.tone === "error" ? styles.pairNoticeError : notice.tone === "success" ? styles.pairNoticeSuccess : styles.pairNotice}>{notice.text}</div>}
    </div>
  );
}
