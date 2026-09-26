/**
 * RcA2SelfCard — 侧栏底部「这台电脑」卡（2026-09-26 对齐拼装稿⑦）。
 *
 * 稿里的码格是常驻明文接入码，但真实后端的接入码**不落盘、只在生成那一刻
 * 可见**（Q2 方案 B 的安全红线），所以码格放的是常驻且安全的**本机设备号短
 * 指纹**（fingerprintOf 前 4 组）：「复制」拷完整设备号（跨网配对要用），
 * 「完整串」一键生成默认档（15 分钟 · 用 1 次 · 可控）并把
 * `PPU-码-设备号` 送进剪贴板；要改档位仍走「无人值守 ›」对话框。
 */
import { useState } from "react";
import { Copy } from "lucide-react";
import type { UseRc } from "@/hooks/useRc";
import type { ToastFn } from "@/components/Toast";
import { fingerprintOf } from "@/lib/fingerprint";
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
}: {
  rc: UseRc;
  toast: ToastFn;
  busy: boolean;
  locked: boolean;
  enabled: boolean;
  onToggleSelf: (enabled: boolean) => void;
  onUnoGenerate: () => void;
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
      await copyText(r.full, "已复制完整接入串（15 分钟 · 用 1 次）", toast);
    } catch (error) {
      toast(String(error), "error");
    } finally {
      setCopyingFull(false);
    }
  };

  return (
    <div className={styles.selfCard}>
      <div className={styles.selfHead}>
        <strong>这台电脑</strong>
        <button
          type="button"
          className={styles.selfCopy}
          disabled={!nodeId}
          title="复制完整设备号（跨网配对 / 固定密码要用）"
          onClick={() => void copyText(nodeId, "已复制本机设备号", toast)}
        >
          <Copy size={11} aria-hidden="true" />
          复制
        </button>
      </div>
      <div
        className={styles.selfCode}
        title={nodeId ? "本机设备号短指纹 · 完整号请点右上「复制」" : "本机身份读取中"}
      >
        {shortId || "读取中…"}
      </div>
      <div className={styles.selfActions}>
        <button
          type="button"
          className={styles.selfGhost}
          disabled={busy || copyingFull || !nodeId}
          title="生成「15 分钟 · 用 1 次 · 可控」接入码，并把完整接入串复制到剪贴板"
          onClick={() => void copyFullString()}
        >
          {copyingFull ? "生成中…" : "完整串"}
        </button>
        <button type="button" className={styles.selfGhost} onClick={onUnoGenerate}>
          无人值守 ›
        </button>
      </div>
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
    </div>
  );
}
