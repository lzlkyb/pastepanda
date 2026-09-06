import { useEffect, useRef, useState } from "react";
import type { KbDevice, KbInviteCreated } from "@/hooks/useKbSync";
import type { ToastFn } from "@/components/Toast";
import { logger } from "@/lib/logger";
import { StepBar, fmtExpire } from "./KbPairSteps";
import { KbJoinRequests, type KbJoinProps } from "./KbJoinRequests";
import styles from "../Settings.module.css";

/** 单按钮的 footer。`.dialog-footer` 是 space-between，不改会靠左。 */
const footerRight = { justifyContent: "flex-end" as const };

/**
 * A 路线（生成端）：命名 → 发送并等待 → 完成。
 *
 * # 🔴 「等待接入」为什么不需要新的后端能力
 *
 * `useKbSync` 本来就在 5 秒轮询 `kb_sync_devices`，所以这里只要盯着
 * 父级传下来的 `devices` 里冒出一个新 `node_id` 就行。
 *
 * 改造前这里是个**死胡同**：复制完码弹窗停在原地，既没有「完成」按钮，
 * 对方接入后也没任何反馈——用户只能关掉弹窗去盯设备列表。
 *
 * # 2026-09-05：把「发送」与「等待」并成一屏
 *
 * 原先是三屏，中间隔着一个「已发出，去等待 →」按钮。但那个按钮不产生任何作用：
 * 用户复制完码去发的时候，本来就已经在等了。现在生成即开始盯，码与等待状态同屏。
 *
 * 顺带：生成成功后**自动复制到剪贴板**（失败就静默退回手动按钮，不弹错：
 * 用户并没主动请求这件事）。界面上必须明说已经复制了，否则用户不知道。
 */
export function CreateFlow({ defaultName, myFingerprint, devices, joins, onCreateInvite, onClose, toast }: {
  /** 本机计算机名，**可能为空串**（后端取不到时故意留空）。 */
  defaultName: string;
  myFingerprint: string;
  devices: KbDevice[];
  /** 对方粘完码拨过来之后，就会在这里出现一条待确认。 */
  joins: KbJoinProps;
  onCreateInvite: (name: string) => Promise<KbInviteCreated>;
  onClose: () => void;
  toast: ToastFn;
}) {
  const [phase, setPhase] = useState<"name" | "code" | "done">("name");
  const [deviceName, setDeviceName] = useState(defaultName);
  const [code, setCode] = useState("");
  const [expiresAt, setExpiresAt] = useState(0);
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const [slow, setSlow] = useState(false);
  const [peerName, setPeerName] = useState("");

  /**
   * 生成邀请码那一刻已配对的设备。之后多出来的那个就是对方。
   * ❗ 快照必须在**进入码屏那一刻**做（以前是进等待屏时），两屏合并后这两个时机是同一个。
   */
  const knownRef = useRef<Set<string>>(new Set());
  const copyTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => { if (copyTimer.current) clearTimeout(copyTimer.current); }, []);

  // 轮询里冒出新设备 = 对方接上了
  useEffect(() => {
    if (phase !== "code") return;
    const fresh = devices.find((d) => !knownRef.current.has(d.node_id));
    if (fresh) {
      setPeerName(fresh.name);
      setPhase("done");
    }
  }, [phase, devices]);

  // 超过 3 分钟换一段排查提示。
  // ❗ **不转失败态**：用户很可能只是拿着码走开了，判它失败是在说谎。
  useEffect(() => {
    if (phase !== "code") return;
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
      // 进码屏即开始盯新设备，所以快照要在这里做。
      knownRef.current = new Set(devices.map((d) => d.node_id));
      setPhase("code");
      // 自动复制：用户下一步必定是复制，没必要再点一次。
      // 失败就静默——按钮还在，用户可以手动点；弹错反而是在为一件他没请求的事报错。
      try {
        await navigator.clipboard.writeText(r.code);
        setCopied(true);
        if (copyTimer.current) clearTimeout(copyTimer.current);
        copyTimer.current = setTimeout(() => setCopied(false), 2000);
      } catch { /* 静默退回手动按钮 */ }
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

  const stepIndex = phase === "name" ? 0 : phase === "code" ? 1 : 2;
  const daysLeft = Math.max(0, Math.ceil((expiresAt - Date.now()) / 86_400_000));

  return (
    <>
      <StepBar labels={["命名", "发送并等待"]} current={stepIndex} />

      {phase === "name" && (
        <>
          <div className="dialog-body">
            <p className={styles.kbPairText}>另一台设备上会显示这个名字。</p>
            {/* ❗ 输入框打开即有值（本机计算机名），从「必须想一个名字」变成「不满意才改」。
                取不到时后端返回空串（不兜底「未知设备」），这里自然就是空框 + 按钮禁用。 */}
            {/* ❗ 项目里**没有**通用的 `.input` 全局类（各处自己定义，如 mcpPortInput）。
                这里原先写的 `className="input"` 是个不存在的类，输入框一直是浏览器默认样式。 */}
            <input className={styles.kbPairInput} autoFocus placeholder="例如：书房台式机"
              value={deviceName} onChange={(e) => setDeviceName(e.target.value)}
              onKeyDown={(e) => { if (e.key === "Enter" && deviceName.trim()) handleCreate(); }} />
            <p className={styles.kbPairNote}>
              {defaultName
                ? "已自动填入本机名称，可以改成你认得出的叫法。"
                : "没有取到本机名称，请起一个你认得出的名字。"}
            </p>
          </div>
          <div className="dialog-footer">
            <button className="btn-secondary" onClick={onClose}>取消</button>
            <button className="btn-primary" onClick={handleCreate}
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
            {/* 自动复制已经把它放进剪贴板了，按钮只剩「再复制一次」的作用，
                所以降成普通按钮；主按钮让给底部。
                自动复制失败时 `copied` 为 false，文案自然退回「复制邀请码」。 */}
            <button className="btn-secondary" onClick={copy}>
              {copied ? "✓ 已复制到剪贴板" : "📋 复制邀请码"}
            </button>
            <p className={styles.kbPairNote}>
              ⏳ <b>{fmtExpire(expiresAt)}</b> 前有效（还剩 {daysLeft} 天）
            </p>

            {/* 🔴 对方粘完码拨过来后，确认框就出现在这里。
                摆在等待文案**之上**：它一出现，等待就结束了，
                用户该看的是它而不是下面那句「等着…」。 */}
            <KbJoinRequests {...joins} />

            {/* 等待状态与码同屏：用户拿着码去发的时候，这边已经在盯了。 */}
            <div className={styles.kbPairWarn}>
              <div className={styles.kbPairCenter} style={{ fontWeight: 700 }}>
                ⏳ 等着另一台设备粘贴这串码…
              </div>
              <div className={styles.kbPairNote} style={{ marginTop: 6 }}>
                在<b>另一台</b> PastePanda 里打开：设置 → 知识库同步 →
                <b>＋ 添加设备</b> → <b>我已经拿到邀请码了</b>，把码粘进去。
              </div>
              <div className={styles.kbPairNote} style={{ marginTop: 6 }}>
                🔐 对方会看到一串指纹，让它和本机的{" "}
                <span className={`${styles.kbPairFp} ${styles.kbPairFpSm}`}>{myFingerprint}</span>{" "}
                一字不差再确认。
              </div>
              {/* ❗ 把「然后还要回来确认一次」写明白。
                  不写的话，用户在对面粘完就以为完事了，回到这台看到的
                  却是一个要他动手的核对框——而那正是配对能不能成的关键一步。 */}
              <div className={styles.kbPairNote} style={{ marginTop: 6 }}>
                它粘完之后，<b>这里会出现一条要你确认的请求</b>（两边各核对一次指纹）。
              </div>
              {slow && (
                <div className={styles.kbPairNote} style={{ marginTop: 6 }}>
                  还没动静？确认两台机器<b>都开了知识库同步开关</b>，以及那串码是整个粘过去的。
                </div>
              )}
            </div>
          </div>
          <div className="dialog-footer" style={footerRight}>
            {/* 关掉不影响配对（配对是对方发起的），文案要说清楚，
                否则用户会以为关掉就前功尽弃。 */}
            <button className="btn-secondary" onClick={onClose}>先关掉，稍后再说</button>
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
            <button className="btn-primary" onClick={onClose}>完成</button>
          </div>
        </>
      )}
    </>
  );
}
