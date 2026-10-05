import { useState } from "react";
import { Copy, Fingerprint, KeyRound, Link, Users } from "lucide-react";
import type { UseRc } from "@/hooks/useRc";
import type { ToastFn } from "@/components/Toast";
import { fingerprintOf } from "@/lib/fingerprint";
import { RcConnectionShell } from "./RcConnectionShell";
import styles from "./RcConnect.module.css";

export function RcMoreConnections({ rc, toast, onClose, onHelp, onUno, onLegacy }: {
  rc: UseRc; toast: ToastFn; onClose: () => void; onHelp?: () => void; onUno: () => void; onLegacy: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const id = rc.identity?.node_id ?? "";
  const copy = async (value: string, message: string) => {
    try { await navigator.clipboard.writeText(value); toast(message, "success"); }
    catch { toast("复制失败，请手动选择文本", "error"); }
  };
  const copyFull = async () => {
    setBusy(true);
    try {
      const result = await rc.unoGenerate({ ttlSecs: 900, unlimited: false, capability: "control", alsoTrust: false });
      await copy(result.full, "已复制完整接入串 · 谁拿到谁可连本机 15 分钟（用 1 次）");
    } catch (error) { toast(String(error), "error"); }
    finally { setBusy(false); }
  };
  const navigate = (action: () => void) => { onClose(); action(); };
  return <RcConnectionShell title="更多连接方式" subtitle="按使用场景选择，授权范围会在下一步说明。" onClose={onClose}>
    <div className={`${styles.body} ${styles.moreList}`}>
      {onHelp && <div className={styles.moreRow}><Users size={22} aria-hidden="true" /><div><strong>一次性帮助</strong><p>双方都在场，让别人帮我或帮别人连一次。</p></div><button type="button" className={styles.button} onClick={() => navigate(onHelp)}>帮助</button></div>}
      <div className={styles.moreRow}><KeyRound size={22} aria-hidden="true" /><div><strong>无人值守</strong><p>为不在电脑旁时的访问配置接入码或固定密码。</p></div><button type="button" className={styles.button} onClick={() => navigate(onUno)}>无人值守</button></div>
      <div className={styles.moreRow}><Fingerprint size={22} aria-hidden="true" /><div><strong>本机设备号</strong><p>{id ? fingerprintOf(id) : "读取中…"}</p></div><button type="button" className={styles.button} disabled={!id} onClick={() => void copy(id, "已复制本机设备号")}><Copy size={14} />复制设备号</button></div>
      <div className={styles.moreRow}><Link size={22} aria-hidden="true" /><div><strong>完整接入串</strong><p>持有者可控制本机，15 分钟内用一次。仅发送给可信的人。</p></div><button type="button" className={styles.button} disabled={busy || !id} onClick={() => void copyFull()}>{busy ? "生成中…" : "完整接入串"}</button></div>
      <div className={styles.actions}><button type="button" className={styles.button} onClick={() => navigate(onLegacy)}>使用完整凭证配对</button></div>
    </div>
  </RcConnectionShell>;
}
