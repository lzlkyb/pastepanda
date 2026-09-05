import { useEffect, useRef, useState } from "react";
import type { KbDevice, KbInviteCreated } from "@/hooks/useKbSync";
import type { ToastFn } from "@/components/Toast";
import { logger } from "@/lib/logger";
import { StepBar, fmtExpire } from "./KbPairSteps";
import styles from "../Settings.module.css";

/** 单按钮的 footer。`.dialog-footer` 是 space-between，不改会靠左。 */
const footerRight = { justifyContent: "flex-end" as const };

/**
 * A 路线（生成端）：命名 → 发送 → 等待接入 → 完成。
 *
 * # 🔴 「等待接入」为什么不需要新的后端能力
 *
 * `useKbSync` 本来就在 5 秒轮询 `kb_sync_devices`，所以这里只要盯着
 * 父级传下来的 `devices` 里冒出一个新 `node_id` 就行。
 *
 * 改造前这里是个**死胡同**：复制完码弹窗停在原地，既没有「完成」按钮，
 * 对方接入后也没任何反馈——用户只能关掉弹窗去盯设备列表。
 */
export function CreateFlow({ defaultName, myFingerprint, devices, onCreateInvite, onClose, toast }: {
  /** 本机计算机名，**可能为空串**（后端取不到时故意留空）。 */
  defaultName: string;
  myFingerprint: string;
  devices: KbDevice[];
  onCreateInvite: (name: string) => Promise<KbInviteCreated>;
  onClose: () => void;
  toast: ToastFn;
}) {
  const [phase, setPhase] = useState<"name" | "code" | "wait" | "done">("name");
  const [deviceName, setDeviceName] = useState(defaultName);
  const [code, setCode] = useState("");
  const [expiresAt, setExpiresAt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [slow, setSlow] = useState(false);
  const [peerName, setPeerName] = useState("");

  /** 进入等待那一刻已配对的设备。之后多出来的那个就是对方。 */
  const knownRef = useRef<Set<string>>(new Set());
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);

  // 轮询里冒出新设备 = 对方接上了
  useEffect(() => {
    if (phase !== "wait") return;
    const fresh = devices.find((d) => !knownRef.current.has(d.node_id));
    if (fresh) {
      setPeerName(fresh.name);
      setPhase("done");
    }
  }, [phase, devices]);

  // 超过 3 分钟换一段排查提示。
  // ❗ **不转失败态**：用户很可能只是拿着码走开了，判它失败是在说谎。
  useEffect(() => {
    if (phase !== "wait") return;
    setSlow(false);
    const t = setTimeout(() => setSlow(true), 180_000);
    return () => clearTimeout(t);
  }, [phase]);

  const handleCreate = async () => {
    const n = deviceName.trim();
    if (!n) return;
    setBusy(true);
    try {
      const r = await onCreateInvite(n);
      setCode(r.code);
      setExpiresAt(r.expires_at);
      setPhase("code");
    } catch (e) {
      logger.warn("生成邀请码失败", e);
      toast(`生成邀请码失败：${e instanceof Error ? e.message : String(e)}`, "error");
    } finally { setBusy(false); }
  };

  // 复制后按钮就地变「✓ 已复制」，不额外弹 toast——用户的视线正在按钮上。
  const copy = async () => {
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      if (copyTimer.current) clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 2000);
    } catch {
      toast("复制失败，请手动选中复制", "error");
    }
  };

  const goWait = () => {
    knownRef.current = new Set(devices.map((d) => d.node_id));
    setPhase("wait");
  };

  const stepIndex = phase === "name" ? 0 : phase === "code" ? 1 : phase === "wait" ? 2 : 3;
  const daysLeft = Math.max(0, Math.ceil((expiresAt - Date.now()) / 86_400_000));

  return (
    <>
      <StepBar labels={["命名", "发送", "等待接入"]} current={stepIndex} />

      {phase === "name" && (
        <>
          <div className="dialog-body">
            <p className={styles.kbPairText}>另一台设备上会显示这个名字。</p>
            {/* ❗ 输入框打开即有值（本机计算机名），从「必须想一个名字」变成「不满意才改」。
                取不到时后端返回空串（不兜底「未知设备」），这里自然就是空框 + 按钮禁用。 */}
            <input className="input" autoFocus placeholder="例如：书房台式机"
              value={deviceName} onChange={(e) => setDeviceName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && deviceName.trim()) handleCreate(); }}
              style={{ width: "100%" }} />
            <p className={styles.kbPairNote}>
              {defaultName
                ? "已自动填入本机名称，可以改成你认得出的叫法。"
                : "没有取到本机名称，请起一个你认得出的名字。"}
            </p>
          </div>
          <div className="dialog-footer">
            <button className="btn" onClick={onClose}>取消</button>
            <button className="btn btn-primary" onClick={handleCreate}
              disabled={busy || !deviceName.trim()}>生成邀请码</button>
          </div>
        </>
      )}

      {phase === "code" && (
        <>
          <div className="dialog-body">
            <p className={styles.kbPairText}>
              把这串码发到你的另一台设备（微信 / 备忘录都行，<b>它本身不是秘密</b>）。
            </p>
            <textarea readOnly value={code} rows={4} className={styles.kbPairMono}
              onFocus={(e) => e.currentTarget.select()} />
            <button className="btn btn-primary" onClick={copy}>
              {copied ? "✓ 已复制" : "📋 复制邀请码"}
            </button>
            <p className={styles.kbPairNote}>
              ⏳ <b>{fmtExpire(expiresAt)}</b> 前有效（还剩 {daysLeft} 天）
            </p>
            <div className={styles.kbPairWarn}>
              🔐 <b>下一步在另一台机器上做</b>：它会显示一串指纹，确认与本机的{" "}
              <span className={`${styles.kbPairFp} ${styles.kbPairFpSm}`}>{myFingerprint}</span>{" "}
              一字不差。
            </div>
          </div>
          <div className="dialog-footer" style={footerRight}>
            <button className="btn btn-primary" onClick={goWait}>已发出，去等待 →</button>
          </div>
        </>
      )}

      {phase === "wait" && (
        <>
          <div className="dialog-body">
            <div className={styles.kbPairPulse}>⏳</div>
            <p className={`${styles.kbPairText} ${styles.kbPairCenter}`} style={{ fontWeight: 700 }}>
              等着另一台设备粘贴这串码…
            </p>
            <p className={styles.kbPairNote}>
              在<b>另一台</b> PastePanda 里打开：设置 → 知识库同步 →
              <b>＋ 添加设备</b> → <b>我已经拿到邀请码了</b>，把码粘进去。
            </p>
            <div className={styles.kbPairWarn}>
              对方会看到一串指纹，让它和本机的{" "}
              <span className={`${styles.kbPairFp} ${styles.kbPairFpSm}`}>{myFingerprint}</span>{" "}
              对上再确认。
            </div>
            {slow && (
              <p className={styles.kbPairNote}>
                还没动静？确认两台机器<b>都开了知识库同步开关</b>，以及那串码是整个粘过去的。
              </p>
            )}
          </div>
          <div className="dialog-footer" style={footerRight}>
            {/* 关掉不影响配对（配对是对方发起的），文案要说清楚，
                否则用户会以为关掉就前功尽弃。 */}
            <button className="btn" onClick={onClose}>先关掉，稍后再说</button>
          </div>
        </>
      )}

      {phase === "done" && (
        <>
          <div className="dialog-body">
            <div className={`${styles.kbPairPulse} ${styles.done}`}>✅</div>
            <p className={`${styles.kbPairText} ${styles.kbPairCenter}`} style={{ fontWeight: 700 }}>
              已连上「{peerName}」
            </p>
            <p className={`${styles.kbPairNote} ${styles.kbPairCenter}`}>笔记开始在两台设备之间同步。</p>
          </div>
          <div className="dialog-footer" style={footerRight}>
            <button className="btn btn-primary" onClick={onClose}>完成</button>
          </div>
        </>
      )}
    </>
  );
}
