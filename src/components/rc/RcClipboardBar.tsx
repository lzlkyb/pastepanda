/**
 * RcClipboardBar — 会话底栏里的剪贴板操作组（不自带外框，由 RcSessionBar 承载）。
 *
 * 方案 B 改造：原先自己裹一层 `.ctrlBar`（各带 margin-top + 边框），是画面下方
 * 三条横条里的第一条。现在只返回内容，排版交给底栏。
 *
 * 常驻的「自动同步开 · 剪贴板变化将发给对方」删掉了：按钮本身就叫「自动同步：开」
 * 且是高亮态，同一句话说两遍只会挤掉底栏里别的东西。只在**失败连续 3 次**时补警示
 * ——那才是需要用户动手的状态。
 */
import { useState } from "react";
import { rcPullClipboard, rcPushClipboard } from "@/lib/api/rc";
import styles from "./RemoteComputer.module.css";

export type ClipPhase = "idle" | "loading" | "ok" | "err";

export function RcClipboardBar({
  clipAuto,
  onToggleAuto,
  lastAutoAt,
  autoFail,
  onStatus,
}: {
  clipAuto: boolean;
  onToggleAuto: () => void;
  lastAutoAt: number;
  /** 自动同步连续失败次数（由 SessionView 累计）。 */
  autoFail: number;
  onStatus: (msg: string, kind: "success" | "error" | "info") => void;
}) {
  const [pullPhase, setPullPhase] = useState<ClipPhase>("idle");
  const [pushPhase, setPushPhase] = useState<ClipPhase>("idle");
  const [pullMsg, setPullMsg] = useState("");
  const [pushMsg, setPushMsg] = useState("");

  const push = async () => {
    setPushPhase("loading");
    setPushMsg("推送中…");
    try {
      const t = await navigator.clipboard.readText();
      if (!t) {
        setPushPhase("err");
        setPushMsg("剪贴板是空的");
        onStatus("剪贴板是空的", "info");
        return;
      }
      await rcPushClipboard(t);
      setPushPhase("ok");
      setPushMsg(`已推送 · ${t.length} 字符`);
      onStatus("已把本机剪贴板推到对方", "success");
    } catch (e) {
      setPushPhase("err");
      setPushMsg(String(e));
      onStatus(String(e), "error");
    }
  };

  const pull = async () => {
    setPullPhase("loading");
    setPullMsg("等待对方剪贴板…");
    try {
      const t = await rcPullClipboard();
      if (t == null || t === "") {
        setPullPhase("err");
        setPullMsg("对方剪贴板为空或拉取失败");
        onStatus("对方剪贴板为空或拉取失败", "info");
      } else {
        await navigator.clipboard.writeText(t);
        setPullPhase("ok");
        setPullMsg(`已写入本机 · ${t.length} 字符`);
        onStatus("已拉取对方剪贴板到本机", "success");
      }
    } catch (e) {
      setPullPhase("err");
      setPullMsg(String(e));
      onStatus(String(e), "error");
    }
  };

  const phaseCls = (p: ClipPhase) =>
    p === "ok" ? styles.fbOk : p === "err" ? styles.fbBad : p === "loading" ? styles.fbInfo : "";

  return (
    <>
      <button
        type="button"
        className={clipAuto ? styles.miniBtnPri : styles.miniBtn}
        onClick={onToggleAuto}
        title="开启后本机剪贴板变化会自动推到对方"
      >
        {clipAuto ? "自动同步：开" : "自动同步剪贴板"}
      </button>
      <button type="button" className={styles.miniBtn} onClick={() => void push()}>
        推送剪贴板
      </button>
      <button type="button" className={styles.miniBtn} onClick={() => void pull()}>
        拉取对方剪贴板
      </button>
      {clipAuto && autoFail >= 3 && (
        <span className={`${styles.fb} ${styles.fbBad}`}>自动同步失败 · 检查剪贴板权限</span>
      )}
      {clipAuto && autoFail < 3 && lastAutoAt > 0 && (
        <span className={`${styles.fb} ${styles.fbOk}`}>自动同步正常</span>
      )}
      {pushPhase !== "idle" && (
        <span className={`${styles.fb} ${phaseCls(pushPhase)}`}>{pushMsg}</span>
      )}
      {pullPhase !== "idle" && (
        <span className={`${styles.fb} ${phaseCls(pullPhase)}`}>{pullMsg}</span>
      )}
    </>
  );
}
