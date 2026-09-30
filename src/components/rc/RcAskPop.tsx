/**
 * RcAskPop — 丙-①：入站远程申请的独立**置顶**浮层（窗口 `rc-ask`，入口 `rcask-main.tsx`）。
 *
 * 本文件是那块窗口的**外壳**：拉状态、按 `mode` 分流到确认卡（这里）或隐私角标
 * （`RcPrivPill`，丙-②）。两种形态共用一块窗口是 Rust 侧 `ask_pop.rs` 文件的决定
 * （每多一个常驻 webview 实测 +34~47 MB），不是这里的偷懒。
 *
 * 与主窗那条 `RcJoinRequests` 的分工：那条住在主窗列表里（用户可能整场都没开窗），
 * 这条是**决策现场**——顶到手头的活之上，答完就收。两条共用同一批措辞
 * （`src/lib/rcAskPop.ts`），不各说各话。
 *
 * 🔴 设计稿 §丙-① 的三点，一一对应：
 * ① 置顶 / 不进任务栏 / **不抢焦点**——全在 Rust 侧（`ask_pop.rs`），这里不碰焦点；
 * ② 只看与控制**分两次授权**：`只同意看屏幕` 只在对方申请可控时出现，点了走
 *    `approve_inbound_as(.., Some(View))`，后端只降不升；
 * ③ 超时 / 被丢弃要给主机一句明确原因：`note` 行 + 「知道了」，不让用户猜。
 *
 * 多条申请**一次只答一条**（先敲门的先答，它离超时最近），其余折成一行「另有 N 条在
 * 等」——高危决策不做列表连点（B6 同源）。
 *
 * 🔴 失败反馈只能做在卡片里：这是**独立 webview**，主窗那套 `app-toast` DOM 事件
 * 到不了这里（AGENTS.md §15.1：触发与反馈同一个可见性域）。
 */
import { useCallback, useEffect, useState } from "react";
import { listen } from "@tauri-apps/api/event";
import { X } from "lucide-react";
import { rcAskHide, rcAskState, rcApproveInbound, rcDenyInbound } from "@/lib/api/rcCommands";
import type { RcAskHost, RcAskMode, RcAskNote, RcInboundKnock } from "@/lib/api/rc";
import { fingerprintOf } from "@/lib/fingerprint";
import {
  rcAskCountdownText,
  rcAskGrantText,
  rcAskLeftMs,
  rcAskNoteText,
  rcAskOfferViewOnly,
  RC_ASK_HINT,
} from "@/lib/rcAskPop";
import { rcDisplayName } from "@/lib/rcDevice";
import { RcPrivPill } from "./RcPrivPill";
import styles from "./RcAskPop.module.css";

/** 原因行读完之后，卡片自己收起来的宽限期（后端那条原因的有效期同一量级）。 */
const NOTE_LINGER_MS = 20_000;

export function RcAskPop() {
  const [mode, setMode] = useState<RcAskMode>("hidden");
  const [host, setHost] = useState<RcAskHost | null>(null);
  const [rows, setRows] = useState<RcInboundKnock[]>([]);
  const [note, setNote] = useState<RcAskNote | null>(null);
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(() => Date.now());
  // 🔴 首次 `rc_ask_state()` 落回之前**一律不许自动收窗**：本组件是挂载在 Rust 刚刚
  // `show()` 出来的窗口上的，第一帧 rows 必然是空数组——那时照「没内容就收起」去
  // `rc_ask_hide()`，等于每次都在刚弹出来的一瞬把它按回去（丙-① 最初的形态）。
  const [ready, setReady] = useState(false);

  const pull = useCallback(async () => {
    try {
      const st = await rcAskState();
      setMode(st.mode);
      setHost(st.host);
      // 先敲门的排前面：它离 120s 超时最近，最该先被答复
      setRows([...st.pending].sort((a, b) => a.first_seen_ms - b.first_seen_ms));
      // note 在 TTL 内每次轮询都给；没读到就不动已经显示的那条
      if (st.note) setNote(st.note);
    } catch {
      // 浮层是告知的放大器，不是失败点：这一次拿不到就等下一次事件重拉
    } finally {
      setReady(true);
    }
  }, []);

  useEffect(() => {
    void pull();
  }, [pull]);

  // 主窗 / 被控端任何状态变化都会广播这条；浮层不持 store，只能跟着重拉
  useEffect(() => {
    let off: (() => void) | null = null;
    let dead = false;
    void listen("rc-session-changed", () => {
      void pull();
    }).then((f) => {
      if (dead) f();
      else off = f;
    });
    return () => {
      dead = true;
      off?.();
    };
  }, [pull]);

  // 倒计时只在真有申请待答时走（窗口收起后不留常驻定时器）
  const awaiting = rows.length > 0;
  useEffect(() => {
    if (!awaiting) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [awaiting]);

  const dismiss = useCallback(() => {
    void rcAskHide().catch(() => {
      /* 收不掉就算了：pending 归零时 Rust 那条过渡仍会把它收走 */
    });
  }, []);

  // 没申请也没原因 → 卡片是块透明但吃鼠标面积的窗，必须立刻收掉。
  // 🔴 `capsule` 形态不在这条路上收：那是隐私指示，收起它正是审计 H1 要修的毛病。
  // 但 capsule 却没有 host（后端两条算式对不上）就是块纯死区，照收。
  useEffect(() => {
    if (!ready) return;
    if (mode === "capsule") {
      if (!host) dismiss();
      return;
    }
    if (rows.length === 0 && !note) dismiss();
  }, [ready, mode, host, rows.length, note, dismiss]);

  // 只剩原因行 → 读完（或宽限期过）就收
  useEffect(() => {
    if (rows.length > 0 || !note) return;
    const t = window.setTimeout(dismiss, NOTE_LINGER_MS);
    return () => window.clearTimeout(t);
  }, [rows.length, note, dismiss]);

  const act = useCallback(
    async (run: () => Promise<unknown>, fail: string) => {
      setBusy(true);
      setErr(null);
      try {
        await run();
      } catch (e) {
        setErr(`${fail}：${String(e)}`);
      } finally {
        setBusy(false);
      }
    },
    [],
  );

  // 分流判据在 Rust（`mode_of`）：它同时看得见 pending、原因行和会话相位，
  // 前端自己再算一遍就是两处真相（改一档忘改另一档 = 角标或卡片凭空消失）。
  if (mode === "capsule") {
    return host ? <RcPrivPill host={host} /> : null;
  }

  const head = rows[0] ?? null;
  if (!head) {
    if (!note) return null;
    return (
      <div className={styles.card}>
        <div className={styles.head}>
          <span className={styles.dot} aria-hidden="true" />
          <span className={styles.who}>刚才那条远程申请已经收了</span>
          <button
            type="button"
            className={styles.close}
            title="关闭"
            aria-label="关闭"
            onClick={dismiss}
          >
            <X size={12} aria-hidden="true" />
          </button>
        </div>
        <p className={styles.note}>{rcAskNoteText(note.code) ?? RC_ASK_HINT}</p>
        <div className={styles.btns}>
          <button type="button" className="btn-secondary go" onClick={dismiss}>
            知道了
          </button>
        </div>
      </div>
    );
  }

  const who = rcDisplayName(head, fingerprintOf(head.peer));
  const left = rcAskLeftMs(head.first_seen_ms, now);
  const noteText = rcAskNoteText(note?.code);

  return (
    <div className={styles.card}>
      <div className={styles.head}>
        <span className={styles.dot} aria-hidden="true" />
        <span className={styles.who}>{who} 想远程这台电脑</span>
        <span className={styles.cd}>{rcAskCountdownText(left)}</span>
        <button
          type="button"
          className={styles.close}
          title="先不理它（申请仍在等，超时会自动拒绝对方）"
          aria-label="先不理它"
          onClick={dismiss}
        >
          <X size={12} aria-hidden="true" />
        </button>
      </div>
      <div className={styles.meta}>
        指纹 <span className={styles.fp}>{fingerprintOf(head.peer)}</span> · 申请：
        <b>{rcAskGrantText(head.capability)}</b>
        {rows.length > 1 && <div className={styles.extra}>另有 {rows.length - 1} 条在等，逐条答</div>}
      </div>
      {err && <div className={styles.err}>{err}</div>}
      {noteText && <div className={styles.note}>{noteText}</div>}
      <div className={styles.btns}>
        <button
          type="button"
          className="btn-secondary"
          disabled={busy}
          onClick={() => void act(() => rcDenyInbound(head.peer), "拒绝失败")}
        >
          拒绝
        </button>
        {rcAskOfferViewOnly(head.capability) && (
          <button
            type="button"
            className="btn-secondary"
            disabled={busy}
            title="只给它看屏幕，不给键鼠"
            onClick={() => void act(() => rcApproveInbound(head.peer, "view"), "只同意看屏幕失败")}
          >
            只同意看屏幕
          </button>
        )}
        <button
          type="button"
          className={`btn-primary ${styles.go}`}
          disabled={busy}
          title={`对方请求的能力：${rcAskGrantText(head.capability)}`}
          onClick={() => void act(() => rcApproveInbound(head.peer), "同意失败")}
        >
          同意远程
        </button>
      </div>
      <div className={styles.foot}>{RC_ASK_HINT}</div>
    </div>
  );
}
