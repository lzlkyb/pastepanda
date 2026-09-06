import { Fragment, useCallback, useEffect, useState } from "react";
import type { KbInvite } from "@/hooks/useKbSync";
import type { ToastFn } from "@/components/Toast";
import { fingerprintOf } from "@/lib/fingerprint";
import { logger } from "@/lib/logger";
import styles from "../Settings.module.css";
import { readClipboardText } from "@/lib/api";

/**
 * 配对向导的共用件 + 粘贴路线。A 路线（生成端）在 `KbPairCreate.tsx`。
 *
 * ❗ 每个屏都返回片段 `<>dialog-body + dialog-footer</>`，
 * 直接挂在 `dialog-box` 下 —— footer 必须是 `dialog-box` 的**直接子元素**
 * 才能被 `.dialog-footer` 的 flex-shrink:0 固在底部，包一层 div 就会跟着内容滚。
 */

/** 顶部 1-2-3 进度条。`current` 从 0 起，小于它的都画成✓。 */
export function StepBar({ labels, current }: { labels: string[]; current: number }) {
  return (
    <div className={styles.kbPairSteps}>
      {labels.map((l, i) => (
        <Fragment key={l}>
          {i > 0 && <span className={styles.kbPairBar} />}
          <span className={`${styles.kbPairStep} ${
            i < current ? styles.done : i === current ? styles.on : ""}`}>
            <b className={styles.kbPairStepNum}>{i < current ? "✓" : i + 1}</b>{l}
          </span>
        </Fragment>
      ))}
    </div>
  );
}

/**
 * 邀请码的**粗筛**：看着像才去调后端解析。
 *
 * 🔴 故意宽松（只看字符集与长度）：宁可多调一次 preview 被后端驳回，
 * 也不能把真邀请码挡在门外——粗筛不过是**静默**忽略的，拦错了用户毫无头绪。
 *
 * 长度阈值 200：邀请码是 `base64(JSON)`，光 node_id（64 hex）+ 签名（约 88）
 * 就远超这个数，而日常剪贴板里那些短串到不了。
 */
export function looksLikeInvite(s: string): boolean {
  // ❗ 先把空白与零宽字符剔干净再判，与后端 `invite::normalize` 同口径：
  //   邀请码靠人在聊天框 / 邮件里搬，路上常被插入软换行或零宽字符。
  //   旧写法直接拿原串套字符集正则，带一个 `\n` 就判失败——而粗筛不过是
  //   **静默**忽略的（剪贴板预读不触发），用户完全不知道发生了什么。
  // 用转义而不是字面量：把零宽字符直接写进源码，下一个人根本看不到它们。
  const t = s.replace(/[\s\u200b-\u200d\uFEFF]/g, "");
  return t.length > 200 && /^[A-Za-z0-9_=+/-]+$/.test(t);
}

/** 绝对时间的到期文案。不写「7 天内」：用户第二天回来已经不知道从哪天算。 */
export function fmtExpire(ms: number): string {
  const d = new Date(ms);
  const p = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}年${d.getMonth() + 1}月${d.getDate()}日 ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 对端身份卡：名字 + 指纹。两条路线都要用。 */
export function PeerCard({ name, nodeId }: { name: string; nodeId: string }) {
  return (
    <div className={styles.kbPairPeer}>
      <div className={styles.kbPairPeerName}>💻 {name}</div>
      <div className={styles.kbPairNote} style={{ marginBottom: 4 }}>它的指纹</div>
      <div className={styles.kbPairFp} style={{ color: "var(--accent-strong)" }}>
        {fingerprintOf(nodeId)}
      </div>
    </div>
  );
}

/** 第一屏：选哪一边。措辞用「动作 + 位置」，不用「邀请方/接受方」这种角色名词。 */
export function RolePick({ onPick }: { onPick: (m: "create" | "paste") => void }) {
  return (
    <div className="dialog-body">
      <p className={styles.kbPairText}>把这台机器和你的另一台连起来。先选一边开始：</p>
      <button className={styles.kbPairPick} onClick={() => onPick("create")}>
        <span className={styles.kbPairPickEmoji}>📤</span>
        <span>
          <span className={styles.kbPairPickTitle}>这台先生成邀请码</span>
          <span className={styles.kbPairPickDesc}>在这台机器上开始，生成一串码发到另一台去</span>
        </span>
      </button>
      <button className={styles.kbPairPick} onClick={() => onPick("paste")}>
        <span className={styles.kbPairPickEmoji}>📥</span>
        <span>
          <span className={styles.kbPairPickTitle}>我已经拿到邀请码了</span>
          <span className={styles.kbPairPickDesc}>另一台已经生成好，我在这台粘贴</span>
        </span>
      </button>
    </div>
  );
}

/**
 * B 路线：粘贴对方的邀请码 → 核对指纹 → 完成。
 *
 * `initialCode` 非空 = 外壳已从剪贴板预读到一串，进来就自动解析，
 * 用户看到的第一屏直接就是指纹核对。
 */
export function PasteFlow({ initialCode, selfNodeId, onPreview, onPair, onClose, toast }: {
  initialCode: string;
  /** 本机 `node_id`，用来当场拦住「粘了自己的邀请码」。 */
  selfNodeId: string;
  onPreview: (code: string) => Promise<KbInvite>;
  onPair: (code: string) => Promise<KbInvite>;
  onClose: () => void;
  toast: ToastFn;
}) {
  const [input, setInput] = useState(initialCode);
  const [fromClip, setFromClip] = useState(!!initialCode);
  const [peer, setPeer] = useState<KbInvite | null>(null);
  const [checked, setChecked] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const preview = useCallback(async (code: string) => {
    const c = code.trim();
    if (!c) return;
    setBusy(true);
    try {
      const inv = await onPreview(c);
      // 🔴 粘自己的码当场拦，不要让用户走完「核对指纹 → 勾选 → 完成」三步才失败。
      // 后端那道校验不能去（前端拿不到 identity 时这里会漏），两道都要。
      // 为何非拦不可：自己的组播公告会被 presence 当成「自己发的」丢掉，
      // 配上也只会得到一个永远离线、重试也没用的幽灵设备。
      if (inv.node_id === selfNodeId) {
        setErr("这是本机自己的邀请码。请把它粘到另一台设备上，和自己配对是没有用的。");
        setPeer(null);
        setChecked(false);
        return;
      }
      setPeer(inv);
      setErr("");
      setChecked(false);
    } catch (e) {
      // 🔴 只走内联红字，**不弹 toast**：toast 会飘走，而这条错误用户要对照着
      // 输入框看。后端对「解不开/结构不对/签名不过/已过期」各写了一句不同的话，
      // 原样透出（规则 #15.3）—— 这些区别正是用户排查的抓手。
      logger.warn("邀请码解析失败", e);
      setErr(typeof e === "string" ? e : e instanceof Error ? e.message : "邀请码无效");
      setPeer(null);
    } finally { setBusy(false); }
  }, [onPreview, selfNodeId]);

  // 外壳预读到了就直接解析，省掉用户再点一次「下一步」。
  // 两个依赖都是稳定的（initialCode 不变、preview 是 useCallback），只跑一次。
  useEffect(() => { if (initialCode) preview(initialCode); }, [initialCode, preview]);

  /**
   * 用户**主动**点「读取剪贴板」。
   * ❗ 与外壳的静默预读不同：这里读不到/为空要明确告诉他，
   * 因为是他刚按的按钮，静默就等于按钮坏了（规则 #15.3）。
   */
  const readClip = async () => {
    try {
      const t = (await readClipboardText()).trim();
      if (!t) { toast("剪贴板是空的", "info"); return; }
      setInput(t);
      setFromClip(true);
      await preview(t);
    } catch {
      toast("读不到剪贴板，请手动粘贴", "error");
    }
  };

  const handlePair = async () => {
    setBusy(true);
    try {
      const inv = await onPair(input.trim());
      toast(`已与「${inv.name}」配对，开始同步`, "success");
      onClose();
    } catch (e) {
      logger.warn("配对失败", e);
      setErr(typeof e === "string" ? e : e instanceof Error ? e.message : "配对失败");
    } finally { setBusy(false); }
  };

  return (
    <>
      <StepBar labels={["读取", "核对指纹"]} current={peer ? 1 : 0} />
      <div className="dialog-body">
        {fromClip && !err ? (
          <div className={styles.kbPairOk}>
            <span>📋 已从剪贴板读到邀请码</span>
            {/* 这次读取必须是**可见**的，并且随时能退回手动态 */}
            <button className={styles.kbPairLink}
              onClick={() => { setFromClip(false); setPeer(null); setInput(""); setErr(""); }}>
              不是这个？手动粘贴
            </button>
          </div>
        ) : (
          <>
            <p className={styles.kbPairText}>把另一台设备生成的邀请码粘进来。</p>
            <textarea rows={4} value={input} placeholder="在这里粘贴邀请码"
              className={`${styles.kbPairMono}${err ? ` ${styles.bad}` : ""}`}
              onChange={(e) => { setInput(e.target.value); setErr(""); setPeer(null); }}
              onBlur={(e) => { if (!peer && e.target.value.trim()) preview(e.target.value); }} />
            {err && (
              <div className={styles.kbPairErr}>
                ⚠️ {err}
                <div className={styles.kbPairNote} style={{ marginTop: 4 }}>
                  回到另一台机器上重新点一次「📋 复制邀请码」，整串粘过来。
                </div>
              </div>
            )}
            <button className="btn-secondary" onClick={readClip} disabled={busy}>📋 读取剪贴板</button>
          </>
        )}

        {peer && (
          <>
            <PeerCard name={peer.name} nodeId={peer.node_id} />
            {/* 🔴 这道核对门不能因为「少一步更友好」而弱化：
                签名只能证明做码的人持有那把私钥，挡不住中途被换。
                详细理由见 `src-tauri/src/sync/invite.rs` 的模块注释。 */}
            <div className={styles.kbPairWarn}>
              ⚠️ 到<b>另一台机器</b>上看一眼它显示的指纹，确认与上面这串一字不差。
              <div className={styles.kbPairNote} style={{ marginTop: 6 }}>
                邀请码是自签的——它能证明「做码的人有那把私钥」，
                <b>但证明不了这个码在路上没被人换掉</b>。核对指纹是唯一能挡住这件事的办法。
              </div>
              <label style={{ display: "flex", gap: 7, marginTop: 10, fontWeight: 600, cursor: "pointer" }}>
                <input type="checkbox" checked={checked}
                  onChange={(e) => setChecked(e.target.checked)} />
                我已核对，两边指纹一致
              </label>
            </div>
          </>
        )}
      </div>
      <div className="dialog-footer">
        <button className="btn-secondary" onClick={onClose}>取消</button>
        <button className="btn-primary" onClick={handlePair} disabled={!peer || !checked || busy}>
          完成配对
        </button>
      </div>
    </>
  );
}
