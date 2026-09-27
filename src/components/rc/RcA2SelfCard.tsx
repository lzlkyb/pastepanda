/** 侧栏底部「这台电脑」卡：高频的互换码配对直接在卡内完成。 */
import { useState } from "react";
import { Copy } from "lucide-react";
import type { UseRc } from "@/hooks/useRc";
import type { ToastFn } from "@/components/Toast";
import { fingerprintOf } from "@/lib/fingerprint";
import { RcA2PairExchange } from "./RcA2PairExchange";
import styles from "./RemoteComputerA2.module.css";

const FULL_TTL_SECS = 15 * 60;

async function copyText(text: string, okMsg: string, toast: ToastFn) {
  try {
    await navigator.clipboard.writeText(text);
    toast(okMsg, "success");
  } catch {
    toast("复制失败，请手动选择文本", "error");
  }
}

export function RcA2SelfCard({
  rc,
  toast,
  busy,
  locked,
  enabled,
  onToggleSelf,
  onUnoGenerate,
  onPair,
}: {
  rc: UseRc;
  toast: ToastFn;
  busy: boolean;
  locked: boolean;
  enabled: boolean;
  onToggleSelf: (enabled: boolean) => void;
  onUnoGenerate: () => void;
  onPair: () => void;
}) {
  const [copyingFull, setCopyingFull] = useState(false);
  const nodeId = rc.identity?.node_id ?? "";
  const shortId = nodeId ? fingerprintOf(nodeId) : "";

  const copyFullString = async () => {
    setCopyingFull(true);
    try {
      const r = await rc.unoGenerate({
        ttlSecs: FULL_TTL_SECS,
        unlimited: false,
        capability: "control",
        alsoTrust: false,
      });
      // 审计 2026-09-27：toast 补后果复述——「谁拿到谁能连」这件事比 TTL 本身
      // 更该在生成那一刻说清楚（一键即生成无确认步，后果必须在反馈里可见）。
      await copyText(
        r.full,
        "已复制完整接入串 · 谁拿到谁可连本机 15 分钟（用 1 次）",
        toast,
      );
    } catch (error) {
      toast(String(error), "error");
    } finally {
      setCopyingFull(false);
    }
  };

  return (
    <div className={styles.selfCard}>
      <div className={styles.selfHead}><strong>这台电脑</strong></div>
      <RcA2PairExchange rc={rc} enabled={enabled} toast={toast} />
      <div className={styles.selfToggleRow}>
        <span className={styles.selfToggleCopy}>
          <strong>允许别人连接本机</strong>
          <small>{enabled ? "已开启，可接收远程请求" : "已暂停接收远程请求"}</small>
        </span>
        <button
          type="button"
          role="switch"
          aria-checked={enabled}
          disabled={busy || locked}
          className={enabled ? styles.receiveOn : styles.receiveOff}
          onClick={() => onToggleSelf(!enabled)}
        >
          {enabled ? "已允许" : "已暂停"}
        </button>
      </div>
      <details className={styles.selfMore}>
        <summary>更多方式与设备号</summary>
        <div className={styles.selfCode} title="本机设备号短指纹">{shortId || "读取中…"}</div>
        <div className={styles.selfActions}>
          <button type="button" className={styles.selfGhost} disabled={!nodeId} onClick={() => void copyText(nodeId, "已复制本机设备号", toast)}><Copy size={11} aria-hidden="true" /> 复制设备号</button>
          <button type="button" className={styles.selfGhost} onClick={onPair}>其他配对方式</button>
        </div>
        <div className={styles.selfActions}>
          <button type="button" className={styles.selfGhost} disabled={busy || copyingFull || !nodeId} onClick={() => void copyFullString()}>{copyingFull ? "生成中…" : "完整接入串"}</button>
          <button type="button" className={styles.selfGhost} onClick={onUnoGenerate}>无人值守 ›</button>
        </div>
      </details>
    </div>
  );
}
