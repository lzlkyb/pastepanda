import { useRef, useState } from "react";
import { useCountdown, usePairCodeVisibility } from "@/hooks/usePairCodeVisibility";
import type { UseRc } from "@/hooks/useRc";
import type { ToastFn } from "@/components/Toast";
import { RcConnectionShell } from "./RcConnectionShell";
import { RcPairCreatePane } from "./RcPairCreatePane";
import { RcPairPastePane } from "./RcPairPastePane";
import styles from "./RcConnect.module.css";

/** 旧完整凭证协议保留为低频兼容入口，使用同一弹窗外壳。 */
export function RcLegacyPairDialog({ rc, toast, onClose, onPairAccepted }: {
  rc: UseRc; toast: ToastFn; onClose: () => void; onPairAccepted?: (id: string) => void;
}) {
  const [mode, setMode] = useState<"create" | "paste">("create");
  const [name, setName] = useState(rc.identity?.device_name ?? "");
  const [created, setCreated] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [remain] = useCountdown(expiresAt);
  const cred = usePairCodeVisibility();
  const peer = useRef("");
  const generate = async () => {
    setBusy(true);
    try {
      const result = await rc.createInvite(name.trim() || rc.identity?.device_name || "");
      setCreated(result.code); setExpiresAt(result.expires_at);
      cred.show();
    } catch (error) { toast(String(error), "error"); }
    finally { setBusy(false); }
  };
  return <RcConnectionShell title="完整凭证配对" subtitle="兼容需要传递完整凭证的设备；日常连接使用扫码或 8 位配对码。" onClose={onClose}>
    <div className={styles.body}>
      <div className={styles.codeModes}>
        <button type="button" aria-pressed={mode === "create"} onClick={() => setMode("create")}>出示本机凭证</button>
        <button type="button" aria-pressed={mode === "paste"} onClick={() => setMode("paste")}>输入对方凭证</button>
      </div>
      {mode === "create" ? <RcPairCreatePane name={name} setName={setName} created={created} expiresAt={expiresAt}
        now={expiresAt ? expiresAt - remain : Date.now()} busy={busy} myFp={rc.identity?.fingerprint ?? "读取中…"}
        selfName={rc.identity?.device_name ?? ""} toast={toast} onGenerate={() => void generate()} onBack={onClose}
        revealed={cred.vis === "shown"} onReveal={() => { if (!created) void generate(); else cred.show(); }} />
        : <RcPairPastePane previewInvite={async (code) => { const result = await rc.previewInvite(code); peer.current = result.node_id; return result; }}
          pair={rc.pair} selfNodeId={rc.identity?.node_id} toast={toast} onBack={onClose} onPaired={(n) => {
            void rc.refreshTargets().then(() => { toast(`已配对远程设备「${n || "新设备"}」`, "success"); if (peer.current) onPairAccepted?.(peer.current); onClose(); });
          }} />}
    </div>
  </RcConnectionShell>;
}
