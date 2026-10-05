/** 侧栏只保留接收开关和连接入口，配对流程统一放进弹窗。 */
import { useState } from "react";
import { QrCode, Keyboard, ChevronRight } from "lucide-react";
import type { UseRc } from "@/hooks/useRc";
import type { ToastFn } from "@/components/Toast";

import { RcMoreConnections } from "@/components/settings/RcMoreConnections";
import connect from "@/components/settings/RcConnect.module.css";
import styles from "./RemoteComputerA2.module.css";

export function RcA2SelfCard({
  rc,
  toast,
  busy,
  locked,
  enabled,
  onToggleSelf,
  onUnoGenerate,
  onPair,
  onHelp,
}: {
  rc: UseRc;
  toast: ToastFn;
  busy: boolean;
  locked: boolean;
  enabled: boolean;
  onToggleSelf: (enabled: boolean) => void;
  onUnoGenerate: () => void;
  onPair: (entry?: "pair" | "pairCode" | "pairNearby" | "pairLegacy") => void;
  onHelp?: () => void;
}) {
  const [moreOpen, setMoreOpen] = useState(false);

  return (
    <div className={styles.selfCard}>
      <div className={styles.selfHead}><strong>这台电脑</strong></div>

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
      <div className={connect.selfEntries}>
        <button type="button" className={connect.entry} onClick={() => onPair("pair")}><QrCode size={22} aria-hidden="true" />手机扫码</button>
        <button type="button" className={connect.entry} onClick={() => onPair("pairCode")}><Keyboard size={22} aria-hidden="true" />输入配对码</button>
      </div>
      <button type="button" className={connect.moreButton} onClick={() => setMoreOpen(true)}>更多连接方式<ChevronRight size={13} aria-hidden="true" /></button>
      {moreOpen && <RcMoreConnections rc={rc} toast={toast} onClose={() => setMoreOpen(false)} onHelp={onHelp} onUno={onUnoGenerate} onLegacy={() => onPair("pairLegacy")} />}

    </div>
  );
}
