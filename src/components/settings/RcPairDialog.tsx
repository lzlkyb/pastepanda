/**
 * RcPairDialog — 远程配对向导：指纹并排对照 + 勾选解锁 + 邀请倒计时。
 *
 * 死锁修复：把「解析邀请码 → 出指纹」从「完成配对」里拆出来成独立的 `preview()`，
 * 由 textarea 的 onBlur / 显式「解析邀请码」按钮 / 剪贴板「填入」三个入口触发，
 * 用户无需先勾选就能看到指纹，勾选框才会渲染，按钮才解得开锁。
 * 按钮可用性的唯一判据见 `canSubmitPair`（src/lib/rcPairState.ts），防死锁回归。
 *
 * 展示件已拆到 RcPairFpBox / RcPairModeSelect / RcPairCreatePane，本文件只留状态与编排。
 */
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { X } from "lucide-react";
import { readClipboardText } from "@/lib/api";
import { FocusTrap } from "@/components/FocusTrap";
import { fingerprintOf } from "@/lib/fingerprint";
import { useDialogAnim } from "@/lib/dialogMotion";
import { canSubmitPair } from "@/lib/rcPairState";
import type { UseRc } from "@/hooks/useRc";
import type { ToastFn } from "@/components/Toast";
import { FpBox } from "./RcPairFpBox";
import { RcPairModeSelect } from "./RcPairModeSelect";
import { RcPairCreatePane } from "./RcPairCreatePane";
import styles from "../rc/RemoteComputer.module.css";

export function looksLikeRcInvite(t: string): boolean {
  const s = t.trim();
  return s.length >= 40 && /^[A-Za-z0-9_-]+$/.test(s);
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
  const anim = useDialogAnim();
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
  const [err, setErr] = useState("");
  const [clipInvite, setClipInvite] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const t = (await readClipboardText()).trim();
        if (alive && looksLikeRcInvite(t)) {
          const inv = await rc.previewInvite(t).catch(() => null);
          if (alive && inv && inv.node_id !== rc.identity?.node_id) {
            setClipInvite(t);
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

  /**
   * 解析邀请码 → 出指纹。独立出来，由 onBlur / 「解析邀请码」按钮 / 剪贴板「填入」触发，
   * 不再依赖「完成」按钮，从而解开死锁。
   * 失败只走内联红字（styles.noteBad），不弹 toast：toast 会飘走，这类错误用户要对照输入框看。
   */
  const preview = async (raw: string) => {
    const c = raw.trim();
    if (!c) return;
    setBusy(true);
    try {
      const inv = await rc.previewInvite(c);
      // 粘自己的码当场拦，不让用户走完「核对指纹 → 勾选 → 完成」三步才失败。
      if (inv.node_id === rc.identity?.node_id) {
        setErr("这是本机自己的邀请码。请把它粘到另一台设备上，和自己配对是没有用的。");
        setPreviewFp(null);
        setChecked(false);
        return;
      }
      setPreviewFp(fingerprintOf(inv.node_id));
      setPreviewName(inv.name || "");
      setChecked(false);
      setErr("");
    } catch (e) {
      setErr(typeof e === "string" ? e : e instanceof Error ? e.message : "邀请码无效");
      setPreviewFp(null);
    } finally {
      setBusy(false);
    }
  };

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

  /** 只做配对。勾选门现在可达：没勾选就点不动（按钮依赖 previewFp）。 */
  const handlePaste = async () => {
    if (!checked) {
      toast("请先核对指纹并勾选", "info");
      return;
    }
    setBusy(true);
    try {
      const ok = await rc.pair(code.trim());
      if (ok) {
        toast(`已配对远程设备「${previewName || "新设备"}」`, "success");
        onClose();
      }
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setBusy(false);
    }
  };

  const myFp = rc.identity?.fingerprint ?? "读取中…";

  return (
    <motion.div
      key="rc-pair"
      {...anim.backdrop}
      className="dialog-backdrop"
      onClick={onClose}
    >
      <FocusTrap>
        <motion.div
          {...anim.panel}
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
              <RcPairModeSelect
                clipInvite={clipInvite}
                onFill={(clip) => {
                  setCode(clip);
                  setMode("paste");
                  void preview(clip);
                }}
                onIgnore={() => setClipInvite(null)}
                onCreate={() => setMode("create")}
                onPaste={() => setMode("paste")}
              />
            )}

            {mode === "create" && (
              <RcPairCreatePane
                name={name}
                setName={setName}
                created={created}
                expiresAt={expiresAt}
                now={now}
                busy={busy}
                myFp={myFp}
                selfName={rc.identity?.device_name ?? ""}
                toast={toast}
                onGenerate={handleCreate}
                onBack={() => setMode(null)}
              />
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
                    background: "var(--card-bg, #fff)",
                    color: "var(--text-primary, #1c1f23)",
                  }}
                  placeholder="粘贴对方发来的远程邀请码"
                  value={code}
                  onChange={(e) => {
                    setCode(e.target.value);
                    setPreviewFp(null);
                    setChecked(false);
                    setErr("");
                  }}
                  onBlur={(e) => {
                    if (!previewFp && e.target.value.trim()) void preview(e.target.value);
                  }}
                />
                {!previewFp && code.trim() && (
                  <button
                    type="button"
                    className={styles.miniBtn}
                    style={{ alignSelf: "flex-start", marginTop: 8 }}
                    onClick={() => void preview(code)}
                  >
                    解析邀请码
                  </button>
                )}
                {err && <div className={styles.noteBad}>{err}</div>}
                {previewFp && (
                  <>
                    <div className={styles.pairPane} style={{ marginTop: 10 }}>
                      <FpBox label="本机指纹（对方屏幕上应显示这一串）" fp={myFp} />
                      <FpBox
                        label="对方指纹（在对方设备上核对是否与此相同）"
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
                      <span>我已在对方设备上核对指纹，两边显示的是同一串（核对不过就不要勾）</span>
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
                    disabled={!canSubmitPair({ code, checked, previewFp, busy })}
                    onClick={() => void handlePaste()}
                  >
                    完成远程配对
                  </button>
                </div>
              </>
            )}
          </div>
        </motion.div>
      </FocusTrap>
    </motion.div>
  );
}
