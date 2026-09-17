/**
 * RcPairDialog — 远程配对向导的**壳**：背景、头部、以及「现在该显示哪一屏」。
 *
 * 设计稿：`design/远程电脑-配对流程重做-设计稿.html`。
 *
 * # 2026-09-17 拆过一次（A3）
 *
 * 这个文件原本 286 行，装了**两条流程**的全部状态。A3 加了局域网这条路之后，
 * 再塞就过红线（`.tsx ≤ 300`）。拆法按屏幕切，每块各管各的状态：
 *
 * | 屏 | 文件 |
 * |---|---|
 * | 入口屏（附近设备 + 邀请码两条路） | `RcPairModeSelect` + `RcNearbyList` |
 * | 生成邀请码 | `RcPairCreatePane`（原有） |
 * | 粘贴邀请码 | `RcPairPastePane`（拆出） |
 * | 6 位数字核对 | `RcPairPin`（拆出） |
 * | 完成 | `RcPairDone`（拆出） |
 *
 * 局域网那一侧的状态与轮询在 `hooks/useRcNearbyPair`。
 *
 * # 显示优先级：局域网配对**压过**邀请码那两屏
 *
 * 对方在局域网里主动发起时，用户可能正停在「生成邀请码」那一屏。
 * 6 位数字是**安全相关的提示**，不能让它在别的屏后面等着——所以只要有一轮
 * 配对在进行，就盖住上面。取消后回到原来那一屏（`mode` 没被清掉）。
 *
 * # 按钮可用性的唯一判据
 *
 * 邀请码那条路是 `canSubmitPair`（`src/lib/rcPairState.ts`），防死锁回归。
 * 方案 C 之后发起侧不再有勾选框——那两个确认点原本要用户各做一次，而发起侧
 * 那次**防不住中间人**（论证见 `sync/invite.rs` 模块头）。
 */
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { X } from "lucide-react";
import { readClipboardText } from "@/lib/api";
import { FocusTrap } from "@/components/FocusTrap";
import { useDialogAnim } from "@/lib/dialogMotion";
import { useRcNearbyPair } from "@/hooks/useRcNearbyPair";
import type { UseRc } from "@/hooks/useRc";
import type { ToastFn } from "@/components/Toast";
import { RcPairModeSelect } from "./RcPairModeSelect";
import { RcPairCreatePane } from "./RcPairCreatePane";
import { RcPairPastePane } from "./RcPairPastePane";
import { RcPairPin } from "./RcPairPin";
import { RcPairDone } from "./RcPairDone";
import styles from "../rc/RemoteComputer.module.css";

export function looksLikeRcInvite(t: string): boolean {
  const s = t.trim();
  return s.length >= 40 && /^[A-Za-z0-9_-]+$/.test(s);
}

export function RcPairDialog({
  rc,
  toast,
  onClose,
  onStartRemote,
}: {
  rc: UseRc;
  toast: ToastFn;
  onClose: () => void;
  /**
   * 「立刻发起远程」的出口（结论见设计稿 §8 #5）。**只有能发起会话的地方才传**
   * ——工具箱传得进来，设置页里的配对入口没有会话上下文，那边就不显示这个按钮。
   */
  onStartRemote?: (peerId: string) => void;
}) {
  const anim = useDialogAnim();
  const near = useRcNearbyPair();
  const [mode, setMode] = useState<"create" | "paste" | null>(null);
  const [clipInvite, setClipInvite] = useState<string | null>(null);
  const [fillCode, setFillCode] = useState("");
  const [name, setName] = useState(rc.identity?.device_name ?? "");
  const [created, setCreated] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);

  // 剪贴板里可能已经躺着一份邀请码：预读一次，只提示不自动填。
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

  // 邀请码倒计时（只在生成了码之后跑）。
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

  const handleConfirmPin = async () => {
    try {
      const out = await near.confirm();
      // `waiting` 不是错误（两端的确认有先后），核对屏自己会显示「等对方核对…」。
      if (out.state === "gone") {
        toast("这次配对已经结束了，请重新发起", "error");
      }
    } catch (e) {
      toast(stringify(e, "确认失败"), "error");
    }
  };

  const handleStartRemote = (peerId: string) => {
    onStartRemote?.(peerId);
    onClose();
  };

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
            {near.done ? (
              <RcPairDone
                done={near.done}
                onClose={onClose}
                onStartRemote={onStartRemote ? handleStartRemote : undefined}
              />
            ) : near.pair ? (
              <RcPairPin
                prompt={near.pair}
                busy={near.busy}
                onConfirm={() => void handleConfirmPin()}
                onCancel={() => void near.cancel()}
              />
            ) : mode === "create" ? (
              <RcPairCreatePane
                name={name}
                setName={setName}
                created={created}
                expiresAt={expiresAt}
                now={now}
                busy={busy}
                myFp={rc.identity?.fingerprint ?? "读取中…"}
                selfName={rc.identity?.device_name ?? ""}
                toast={toast}
                onGenerate={handleCreate}
                onBack={() => setMode(null)}
              />
            ) : mode === "paste" ? (
              <RcPairPastePane
                previewInvite={rc.previewInvite}
                pair={rc.pair}
                selfNodeId={rc.identity?.node_id}
                initialCode={fillCode}
                toast={toast}
                onBack={() => setMode(null)}
                onPaired={(n) => {
                  toast(`已配对远程设备「${n || "新设备"}」`, "success");
                  onClose();
                }}
              />
            ) : (
              <RcPairModeSelect
                neighbors={near.neighbors}
                busy={near.busy}
                clipInvite={clipInvite}
                onPair={(n) =>
                  void near
                    .startPair(n.node_id)
                    .catch((e) => toast(stringify(e, "发起配对失败"), "error"))
                }
                onFill={(clip) => {
                  setFillCode(clip);
                  setMode("paste");
                }}
                onIgnore={() => setClipInvite(null)}
                onCreate={() => setMode("create")}
                onPaste={() => setMode("paste")}
              />
            )}
          </div>
        </motion.div>
      </FocusTrap>
    </motion.div>
  );
}

/** 后端错误是字符串，异常可能是 Error——两种都要能变成人话。 */
function stringify(e: unknown, fallback: string): string {
  return typeof e === "string" ? e : e instanceof Error ? e.message : fallback;
}
