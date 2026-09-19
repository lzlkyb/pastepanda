/**
 * RcPairPastePane — 跨网那条路的「粘贴对方邀请码」半边。
 *
 * 从 `RcPairDialog.tsx` 拆出来的（2026-09-17，A3）：那边要同时装下局域网
 * 与邀请码**两条**流程，一个文件塞不下（红线 300 行）。拆的边界是
 * 「一次粘贴的全过程」——输入、解析、校验、发起，状态全在本文件里。
 *
 * 设计稿：`design/远程电脑-配对流程重做-设计稿.html` §4.5。
 *
 * # 🔴 发起侧没有勾选框（方案 C）
 *
 * 原本这里有「我已在对方设备上核对指纹」一勾。删它的理由不只是少一步：
 * 那次核对**防不住中间人**——邀请码是自签的，攻击者换成自己那份，
 * 两端显示的都是攻击者的指纹，用户认真比对了也会一致。真正把关的是
 * **生成方那一侧**的确认，因为那才是写入白名单的一侧。
 *
 * # 为什么解析要独立成一次调用
 *
 * 死锁修复（2026-09-05）：把「解析邀请码 → 出指纹」从「完成配对」里拆出来，
 * 由 textarea 的 onBlur / 显式按钮 / 剪贴板「填入」三个入口触发。
 * 粘自己的码在这里就当场拦住，不让用户走完流程才失败。
 */
import { useEffect, useState } from "react";
import type { RcInvite } from "@/lib/api/rc";
import { fingerprintOf } from "@/lib/fingerprint";
import { canSubmitPair } from "@/lib/rcPairState";
import type { ToastFn } from "@/components/Toast";
import { FpBox } from "./RcPairFpBox";
import styles from "../rc/RemoteComputer.module.css";

export function RcPairPastePane({
  previewInvite,
  pair,
  selfNodeId,
  initialCode,
  toast,
  onBack,
  onPaired,
  adhoc,
  onAdhocPaired,
}: {
  previewInvite: (code: string) => Promise<RcInvite>;
  /** 返回是否成功；失败原因由 store 收进 `error`（`rcStore.run` 的语义）。 */
  pair: (code: string) => Promise<boolean>;
  selfNodeId: string | undefined;
  /** 剪贴板「填入」带进来的码；挂载时自动解析一次。 */
  initialCode?: string;
  toast: ToastFn;
  onBack: () => void;
  /** 配对成功（长期）：把对方名字交给调用方去 toast 并关闭对话框。 */
  onPaired?: (peerName: string) => void;
  /**
   * 一次性协助（方案甲 · 协助方）：配对成功**不进完成屏**，直接连过去。
   * 文案改成「连接」——「配对」这个词在一次性场景里是多余的中间概念。
   */
  adhoc?: boolean;
  /** 一次性协助专用收尾：带 `peer_id`（调用方要拿它点名遗忘）。 */
  onAdhocPaired?: (peerId: string, peerName: string) => void;
}) {
  const [code, setCode] = useState(initialCode ?? "");
  const [fp, setFp] = useState<string | null>(null);
  /**
   * 对方 node_id。原先只留了格式化后的指纹（`fp`），而一次性协助的收尾要用
   * 原始 id 去 `rc_forget` —— 指纹是给人念的，反解不回来。
   */
  const [peerId, setPeerId] = useState<string | null>(null);
  const [peerName, setPeerName] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  /**
   * 解析邀请码 → 出指纹。
   *
   * 失败只走内联红字（`styles.noteBad`），不弹 toast：toast 会飘走，
   * 这类错误用户要对照输入框看。
   */
  const preview = async (raw: string) => {
    const c = raw.trim();
    if (!c) return;
    setBusy(true);
    try {
      const inv = await previewInvite(c);
      // 粘自己的码当场拦，不让用户走完「核对指纹 → 完成」才失败。
      if (inv.node_id === selfNodeId) {
        setErr("这是本机自己的邀请码。请把它粘到另一台设备上，和自己配对是没有用的。");
        setFp(null);
        setPeerId(null);
        return;
      }
      setFp(fingerprintOf(inv.node_id));
      setPeerId(inv.node_id);
      setPeerName(inv.name || "");
      setErr("");
    } catch (e) {
      setErr(typeof e === "string" ? e : e instanceof Error ? e.message : "邀请码无效");
      setFp(null);
      setPeerId(null);
    } finally {
      setBusy(false);
    }
  };

  // 剪贴板「填入」进来的码：挂载就解析，用户不用再点一次「解析邀请码」。
  useEffect(() => {
    if (initialCode?.trim()) void preview(initialCode);
    // 只在挂载时跑一次：之后换码由 onBlur / 按钮驱动。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const submit = async () => {
    setBusy(true);
    try {
      const ok = await pair(code.trim());
      if (!ok) return;
      /**
       * 一次性协助的收尾交给调用方：他要「点名遗忘 + 直接发起」两件事，
       * 而这两件都需要 `peer_id`。走不进 `onAdhocPaired`（没解析出 id）时
       * 退回长期那条收尾，至少不会让用户点完按钮什么都没发生。
       */
      if (adhoc && onAdhocPaired && peerId) onAdhocPaired(peerId, peerName);
      else onPaired?.(peerName);
    } catch (e) {
      toast(String(e), "error");
    } finally {
      setBusy(false);
    }
  };
  /** 一次性协助的文案要避开「配对」——这一步的心智是「连过去」，不是「建立长期关系」。 */
  const primaryLabel = adhoc ? "连接" : "发送配对请求";
  return (
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
          setFp(null);
          setPeerId(null);
          setErr("");
        }}
        onBlur={(e) => {
          if (!fp && e.target.value.trim()) void preview(e.target.value);
        }}
      />
      {!fp && code.trim() && (
        <button
          type="button"
          className={styles.miniBtn}
          style={{ alignSelf: "flex-start" }}
          onClick={() => void preview(code)}
        >
          解析邀请码
        </button>
      )}
      {err && <div className={styles.noteBad}>{err}</div>}
      {fp && (
        <>
          {/* 方案 C 之后这里**只显示对方**的指纹：确认已经移到生成方那一侧，
              而那一侧看到的正是「谁的指纹来敲的门」。发起方不再需要把自己那份
              摆出来供人念——原来那个「本机指纹」框只为跨屏比对而存在。 */}
          <div className={styles.pairPane}>
            <FpBox
              label="将与之配对（对方屏幕上应显示这一串）"
              fp={fp}
              name={peerName}
              accent
            />
          </div>
          <div className={styles.foot}>
            发出去之后，<b>对方那台会弹出确认</b>（带你的指纹与设备名）——
            由对方点头，这次配对才算数。
          </div>
        </>
      )}
      <div style={{ display: "flex", gap: 8, justifyContent: "flex-end" }}>
        <button type="button" className={styles.miniBtn} onClick={onBack}>
          返回
        </button>
        <button
          type="button"
          className={styles.miniBtnPri}
          disabled={!canSubmitPair({ code, previewFp: fp, busy })}
          onClick={() => void submit()}
        >
          {primaryLabel}
        </button>
      </div>
    </>
  );
}
