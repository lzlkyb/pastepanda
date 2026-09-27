import { useEffect, useState } from "react";
import { readClipboardText } from "@/lib/api";
import { rcExchangeCheck, rcShortPairBegin, rcShortPairCancel, rcShortPairCode } from "@/lib/api/rc";
import { formatShortCode, shortCodeFromClipboard, shortCodeFromInput } from "@/lib/rcShortCode";
import { useWindowVisible } from "@/hooks/useWindowVisible";
import type { UseRc } from "@/hooks/useRc";
import type { ToastFn } from "@/components/Toast";
import styles from "./RemoteComputerA2.module.css";

type Notice = { tone: "info" | "success" | "error"; text: string } | null;

/** 双方各交换八位码，点击确认后通过现有 P2P 通道完成配对。 */
export function RcA2PairExchange({ rc, toast }: {
  rc: UseRc;
  toast: ToastFn;
}) {
  const visible = useWindowVisible();
  const [ownCode, setOwnCode] = useState("");
  const [expiresAt, setExpiresAt] = useState(0);
  const [peerCode, setPeerCode] = useState("");
  const [peerId, setPeerId] = useState("");
  const [peerName, setPeerName] = useState("");
  const [phase, setPhase] = useState<"idle" | "joining" | "waiting" | "paired" | "error">("idle");
  const [notice, setNotice] = useState<Notice>(null);
  const refreshTargets = rc.refreshTargets;

  useEffect(() => {
    if (phase !== "joining") return;
    return () => { void rcShortPairCancel(); };
  }, [phase]);

  useEffect(() => {
    if (!rc.identity?.node_id) return;
    let cancelled = false;
    void rcShortPairCode().then((r) => {
      if (!cancelled) { setOwnCode(r.code); setExpiresAt(r.expires_at); }
    }).catch((error) => {
      if (!cancelled) setNotice({ tone: "error", text: `获取配对码失败：${String(error)}` });
    });
    return () => { cancelled = true; };
  }, [rc.identity?.node_id]);

  // 窗口获焦时只识别带 PP 前缀的码，不在后台监听剪贴板。
  useEffect(() => {
    if (!visible || peerCode || !ownCode || phase === "paired") return;
    let cancelled = false;
    void readClipboardText().then((text) => {
      const code = shortCodeFromClipboard(text);
      if (!cancelled && code && code !== ownCode) {
        setPeerCode(formatShortCode(code));
        setNotice({ tone: "info", text: "已识别对方的配对码，点确认即可配对。" });
      }
    }).catch(() => {});
    return () => { cancelled = true; };
  }, [visible, peerCode, ownCode, phase]);

  // 码到期时换新；只排一次到期任务，不做常驻倒计时。
  useEffect(() => {
    if (!expiresAt) return;
    const timer = window.setTimeout(() => {
      void rcShortPairCode().then((r) => {
        setOwnCode(r.code);
        setExpiresAt(r.expires_at);
        if (phase !== "paired") {
          setPhase("error");
          setNotice({ tone: "info", text: "配对码已更新，请把新码发给对方。" });
        }
      }).catch((error) => setNotice({ tone: "error", text: `更新配对码失败：${String(error)}` }));
    }, Math.max(0, expiresAt - Date.now()));
    return () => window.clearTimeout(timer);
  }, [expiresAt, phase]);

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
          setPeerCode("");
          void refreshTargets();
          toast(`已与「${peerName}」配对`, "success");
          void rcShortPairCode().then((r) => {
            if (!cancelled) { setOwnCode(r.code); setExpiresAt(r.expires_at); }
          });
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
    if (!ownCode) return;
    try {
      await navigator.clipboard.writeText(`PP-${ownCode.slice(0, 4)}-${ownCode.slice(4)}`);
      setNotice({ tone: "success", text: "已复制，发给对方；也请对方把自己的码发给你。" });
    } catch {
      setNotice({ tone: "error", text: "复制失败，请选中上方的码手动复制。" });
    }
  };

  const begin = async () => {
    const code = shortCodeFromInput(peerCode);
    if (!ownCode || !code || code === ownCode) return;
    setPhase("joining");
    setNotice({ tone: "info", text: "正在等待对方也确认配对…" });
    try {
      const peer = await rcShortPairBegin(ownCode, code);
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

  return (
    <div className={styles.pairExchange}>
      {/* 🔴 aria-label 不能挂在无 role 的 div/span 上（读屏会丢弃，见 rcA11yNames
          守卫）——整行收成命名 group，码值本身靠「我的码」标签相邻可读。 */}
      <div className={styles.pairCodeRow} role="group" aria-label="我的配对码">
        <span className={styles.pairLabel}>我的码</span>
        <span className={styles.pairShortCode}>{ownCode ? formatShortCode(ownCode) : "获取中…"}</span>
        <button type="button" className={styles.pairSecondary} disabled={!ownCode} onClick={() => void copyCode()}>复制</button>
      </div>
      <div className={styles.pairPeerRow}>
        <input
          aria-label="对方的配对码"
          inputMode="numeric"
          maxLength={12}
          value={peerCode}
          onChange={(e) => { setPeerCode(e.target.value); if (phase === "error") setPhase("idle"); }}
          placeholder="粘贴对方的 8 位码"
        />
        <button type="button" className={styles.pairPrimary} disabled={!ownCode || !shortCodeFromInput(peerCode) || shortCodeFromInput(peerCode) === ownCode || phase === "joining" || phase === "waiting"} onClick={() => void begin()}>
          {phase === "joining" || phase === "waiting" ? "等待中" : "确认"}
        </button>
      </div>
      {notice && <div role={notice.tone === "error" ? "alert" : "status"} className={notice.tone === "error" ? styles.pairNoticeError : notice.tone === "success" ? styles.pairNoticeSuccess : styles.pairNotice}>
        <span>{notice.text}</span>
        {phase === "joining" && <button type="button" className={styles.pairCancel} onClick={() => void rcShortPairCancel()}>取消</button>}
      </div>}
    </div>
  );
}
