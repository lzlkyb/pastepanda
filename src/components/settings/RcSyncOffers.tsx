/**
 * RcSyncOffers — 「远程已配对、是否允许同步笔记」确认条。
 *
 * 方案 A 反向门：远程配对**不会**自动进知识库同步；用户点头才 `device_pair`。
 * 挂在 KbSyncPanel 顶部（与 KbJoinRequests 同级：需要用户现在就做一件事）。
 */
import { useCallback, useEffect, useState } from "react";
import { fingerprintOf } from "@/lib/fingerprint";
import {
  kbSyncAllowFromRc,
  kbSyncDenyFromRc,
  rcSyncOffers,
  type RcSyncOffer,
} from "@/lib/api/rc";
import type { ToastFn } from "@/components/Toast";
import styles from "../Settings.module.css";

export function RcSyncOffers({
  toast,
  busy,
  onChanged,
}: {
  toast: ToastFn;
  busy: boolean;
  onChanged: () => void;
}) {
  const [offers, setOffers] = useState<RcSyncOffer[]>([]);

  const load = useCallback(async () => {
    try {
      setOffers(await rcSyncOffers());
    } catch {
      /* 读失败不打断面板 */
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  if (offers.length === 0) return null;

  return (
    <div className={styles.kbPairWarn} style={{ marginBottom: 12 }}>
      <div style={{ fontWeight: 700, marginBottom: 6 }}>
        🔔 有 {offers.length} 台远程配对设备可加入笔记同步
      </div>
      <div className={styles.kbPairNote} style={{ marginBottom: 10 }}>
        远程配对<b>不会</b>自动同步笔记。允许后才会与这台设备同步知识库。
      </div>
      {offers.map((o) => (
        <div key={o.node_id} className={styles.kbPairPeer} style={{ marginBottom: 8 }}>
          <div className={styles.kbPairNote} style={{ marginBottom: 4 }}>
            {o.name || "未命名设备"} · 指纹
          </div>
          <div className={styles.kbPairFp} style={{ color: "var(--accent-strong)" }}>
            {fingerprintOf(o.node_id)}
          </div>
          <div style={{ display: "flex", gap: 8, marginTop: 8, justifyContent: "flex-end" }}>
            <button
              className="btn-secondary"
              disabled={busy}
              onClick={async () => {
                try {
                  await kbSyncDenyFromRc(o.node_id);
                  toast("已忽略，不再提示同步这台设备", "info");
                  await load();
                } catch (e) {
                  toast(String(e), "error");
                }
              }}
            >
              不同步
            </button>
            <button
              className="btn-primary"
              disabled={busy}
              onClick={async () => {
                try {
                  await kbSyncAllowFromRc(o.node_id, o.name);
                  toast(`已允许与「${o.name || "该设备"}」同步笔记`, "success");
                  await load();
                  onChanged();
                } catch (e) {
                  toast(String(e), "error");
                }
              }}
            >
              允许同步笔记
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}
