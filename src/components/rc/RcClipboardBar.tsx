/**
 * RcClipboardBar — 剪贴板操作组（不自带外框，由宿主承载；2026-09-24 起住在
 * RcSessionCapsule 的「⋯」面板里，原会话底栏已删）。
 *
 * 方案 B 改造：原先自己裹一层 `.ctrlBar`（各带 margin-top + 边框），是画面下方
 * 三条横条里的第一条。现在只返回内容，排版交给宿主。深面板里的浅底配色由
 * `.capMore` 后代选择器统一翻色，本组件零改动。
 *
 * 常驻的「自动同步开 · 剪贴板变化将发给对方」删掉了：按钮本身就叫「自动同步：开」
 * 且是高亮态，同一句话说两遍只会挤掉底栏里别的东西。只在**失败连续 3 次**时补警示
 * ——那才是需要用户动手的状态。
 */
import { useCallback, useState } from "react";
import { rcPullClipboard, rcPushClipboard } from "@/lib/api/rc";
import { useOkAutoClear } from "@/hooks/useOkAutoClear";
import styles from "./RemoteComputer.module.css";

export type ClipPhase = "idle" | "loading" | "ok" | "info" | "err";

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
  // P3-5：成功/信息浮条 6s 自清；错误保留并给重试
  const clearPush = useCallback(() => {
    setPushPhase("idle");
    setPushMsg("");
  }, []);
  const clearPull = useCallback(() => {
    setPullPhase("idle");
    setPullMsg("");
  }, []);
  useOkAutoClear(pushPhase === "idle" ? null : pushPhase, clearPush);
  useOkAutoClear(pullPhase === "idle" ? null : pullPhase, clearPull);

  const push = async () => {
    setPushPhase("loading");
    setPushMsg("推送中…");
    try {
      const t = await navigator.clipboard.readText();
      if (!t) {
        // 真空白不是失败：不给重试（重试也还是空）
        setPushPhase("info");
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
      // 🔴 后端契约（C5 并行批次，2026-09-25 注）：后端正在把「超时返回空」改为
      // 返回 Err——落地后超时/作废都以 reject 报出（下方 catch 接住）。因此
      // 下面这个 `t == null` 分支从「兜住失真契约」变成**纯防御**：仅防旧版
      // 对端 / 未来契约回归。行为不动，别删。
      const t = await rcPullClipboard();
      if (t === "") {
        // 真空白 ≠ 拉取失败（U3.5）：不给重试
        setPullPhase("info");
        setPullMsg("对方剪贴板是空的");
        onStatus("对方剪贴板是空的", "info");
      } else if (t == null) {
        // 纯防御分支（见上）：契约改造后理论上不可达
        setPullPhase("err");
        setPullMsg("拉取对方剪贴板失败");
        onStatus("拉取对方剪贴板失败", "error");
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
    p === "ok"
      ? styles.fbOk
      : p === "err"
        ? styles.fbBad
        : p === "loading" || p === "info"
          ? styles.fbInfo
          : "";

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
      {/* U3.5：失败必须给重试入口（空态不需要——对方空剪贴板重试也还是空） */}
      {(pushPhase === "err" || pullPhase === "err") && (
        <button
          type="button"
          className={styles.miniBtn}
          onClick={() => void (pushPhase === "err" ? push() : pull())}
        >
          重试
        </button>
      )}
    </>
  );
}
