/**
 * RcPairDialog — 远程配对向导：指纹并排对照 + 勾选解锁 + 邀请倒计时。
 */
import { useEffect, useState } from "react";
import { X } from "lucide-react";
import { readClipboardText } from "@/lib/api";
import { FocusTrap } from "@/components/FocusTrap";
import { fingerprintOf } from "@/lib/fingerprint";
import { formatDuration } from "@/lib/rcSessionStats";
import type { UseRc } from "@/hooks/useRc";
import type { ToastFn } from "@/components/Toast";
import styles from "../rc/RemoteComputer.module.css";

export function looksLikeRcInvite(t: string): boolean {
  const s = t.trim();
  return s.length >= 40 && /^[A-Za-z0-9_-]+$/.test(s);
}

function FpBox({ label, fp, name, accent }: {
  label: string;
  fp: string;
  name?: string;
  accent?: boolean;
}) {
  return (
    <div className={styles.fpBox}>
      <div className={styles.fpLabel}>{label}</div>
      <div className={styles.fpVal} style={accent ? { color: "var(--accent, #4f7cff)" } : undefined}>
        {fp}
      </div>
      {name != null && (
        <>
          <div className={styles.fpLabel} style={{ marginTop: 8 }}>设备名</div>
          <div style={{ fontSize: 12, marginTop: 2 }}>{name || "（未填）"}</div>
        </>
      )}
    </div>
  );
}

export function RcPairDialog({
  rc,
  toast,
  onClose,
}: {
  rc: UseRc;
  toast: ToastFn;
  onClose: () => void;
}) {
  const [mode, setMode] = useState<"create" | "paste" | null>(null);
  const [name, setName] = useState(rc.identity?.device_name ?? "");
  const [code, setCode] = useState("");
  const [created, setCreated] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [previewFp, setPreviewFp] = useState<string | null>(null);
  const [previewName, setPreviewName] = useState("");
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const t = (await readClipboardText()).trim();
        if (alive && looksLikeRcInvite(t)) {
          const inv = await rc.previewInvite(t).catch(() => null);
          if (alive && inv && inv.node_id !== rc.identity?.node_id) {
            setCode(t);
            setPreviewFp(fingerprintOf(inv.node_id));
            setPreviewName(inv.name || "");
            setMode("paste");
          }
        }
      } catch {
        /* 预读失败静默 */
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!created || !expiresAt) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [created, expiresAt]);

  const handleCreate = async () => {
    setBusy(true);
    try {
      const r = await rc.createInvite(name.trim() || rc.identity?.device_name || "");
      setCreated(r.code);
      setExpiresAt(r.expires_at);
      setNow(Date.now());
      try {
        await navigator.clipboard.writeText(r.code);
        toast("邀请码已复制，请发给对方", "success");
      } catch {
        toast("邀请码已生成，请手动复制", "info");
      }
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const handlePaste = async () => {
    setBusy(true);
    try {
      const inv = await rc.previewInvite(code.trim());
      if (inv.node_id === rc.identity?.node_id) {
        toast("这是本机自己的邀请码", "error");
        return;
      }
      setPreviewFp(fingerprintOf(inv.node_id));
      setPreviewName(inv.name || "");
      if (!checked) {
        toast("请先核对指纹并勾选", "info");
        return;
      }
      const ok = await rc.pair(code.trim());
      if (ok) {
        toast(`已配对远程设备「${inv.name || "新设备"}」`, "success");
        onClose();
      }
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const myFp = rc.identity?.fingerprint ?? "读取中…";
  const remain = expiresAt > 0 ? Math.max(0, expiresAt - now) : 0;

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <FocusTrap>
        <div
          className="dialog-box"
          style={{ width: "min(480px, 94vw)" }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="dialog-header">
            <h2 className="dialog-title">远程配对</h2>
            <button className="dialog-close" onClick={onClose} aria-label="关闭">
              <X size={15} />
            </button>
          </div>
          <div className={styles.body}>
            <div className={styles.foot}>
              与「知识库同步」配对是两回事：这里只授权远程协助，不共享笔记。
            </div>

            {mode === null && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
                <button
                  type="button"
                  className={styles.miniBtnPri}
                  onClick={() => setMode("create")}
                >
                  生成邀请码（给对方粘）
                </button>
                <button
                  type="button"
                  className={styles.miniBtn}
                  onClick={() => setMode("paste")}
                >
                  粘贴对方的邀请码
                </button>
              </div>
            )}

            {mode === "create" && (
              <>
                <div className={styles.pairPane}>
                  <FpBox label="本机指纹（对方核对用）" fp={myFp} name={name || rc.identity?.device_name || ""} />
                  <div className={styles.fpBox}>
                    <div className={styles.fpLabel}>设备名（对方列表里显示）</div>
                    <input
                      style={{
                        width: "100%",
                        marginTop: 4,
                        font: "inherit",
                        fontSize: 12,
                        padding: "6px 8px",
                        borderRadius: 6,
                        border: "1px solid var(--border-color, #e3e6ea)",
                        background: "var(--card-bg, #fff)",
                        color: "var(--text-primary)",
                      }}
                      placeholder="例如：办公室台式机"
                      value={name}
                      onChange={(e) => setName(e.target.value)}
                    />
                    {created && (
                      <div className={styles.noteWarn} style={{ marginTop: 10 }}>
                        邀请码已生成，对方粘贴并核对指纹后会出现待确认。
                        {remain > 0 && (
                          <>
                            {" "}
                            剩余 <b>{formatDuration(remain)}</b>
                          </>
                        )}
                      </div>
                    )}
                  </div>
                </div>
                {!created ? (
                  <button
                    type="button"
                    className={styles.miniBtnPri}
                    disabled={busy}
                    onClick={() => void handleCreate()}
                  >
                    生成并复制
                  </button>
                ) : null}
                <button type="button" className={styles.miniBtn} onClick={() => setMode(null)}>
                  返回
                </button>
              </>
            )}

            {mode === "paste" && (
              <>
                <textarea
                  style={{
                    width: "100%",
                    minHeight: 72,
                    fontSize: 12,
                    fontFamily: "ui-monospace, Consolas, monospace",
                    borderRadius: 8,
                    border: "1px solid var(--border-color, #e3e6ea)",
                    padding: 8,
                    resize: "vertical",
                  }}
                  placeholder="粘贴对方发来的远程邀请码"
                  value={code}
                  onChange={(e) => setCode(e.target.value)}
                />
                {previewFp && (
                  <>
                    <div className={styles.pairPane} style={{ marginTop: 10 }}>
                      <FpBox label="本机指纹" fp={myFp} />
                      <FpBox
                        label="对方指纹（必须一致）"
                        fp={previewFp}
                        name={previewName}
                        accent
                      />
                    </div>
                    <label className={styles.checkLine}>
                      <input
                        type="checkbox"
                        checked={checked}
                        onChange={(e) => setChecked(e.target.checked)}
                      />
                      <span>我已与对方核对指纹一致（核对不过就不要勾）</span>
                    </label>
                  </>
                )}
                <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
                  <button type="button" className={styles.miniBtn} onClick={() => setMode(null)}>
                    返回
                  </button>
                  <button
                    type="button"
                    className={styles.miniBtnPri}
                    disabled={busy || !code.trim() || !checked}
                    onClick={() => void handlePaste()}
                  >
                    完成远程配对
                  </button>
                </div>
              </>
            )}
          </div>
        </div>
      </FocusTrap>
    </div>
  );
}
