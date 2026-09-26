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
 * | 入口屏（附近设备主路 + 折叠「高级」两条码路） | `RcPairModeSelect` + `RcNearbyList` |
 * | 生成配对码 | `RcPairCreatePane`（原有） |
 * | 粘贴配对码（含剪贴板「填入」询问） | `RcPairPastePane`（拆出） |
 * | 6 位数字核对 | `RcPairPin`（拆出） |
 *
 * 局域网那一侧的状态与轮询在 `hooks/useRcNearbyPair`。
 *
 * # 2026-09-26 乙方案瘦身
 *
 * 主路只剩「附近设备」；邀请码两条路折进「高级」（留一版观察）；
 * 剪贴板检测到码的询问从首屏挪进粘贴屏——已经决定粘码的人才是帮忙，
 * 一开屏就拦是打扰（跨网第一次连接的正路已改走「帮助」流程）。
 * **完成屏（RcPairDone）删除**：成功那一刻直接关窗 + toast + 选中新设备。
 *
 * # 显示优先级：局域网配对**压过**两条码路那两屏
 *
 * 对方在局域网里主动发起时，用户可能正停在「生成配对码」那一屏。
 * 6 位数字是**安全相关的提示**，不能让它在别的屏后面等着——所以只要有一轮
 * 配对在进行，就盖住上面。取消后回到原来那一屏（`mode` 没被清掉）。
 *
 * # 按钮可用性的唯一判据
 *
 * 邀请码那条路是 `canSubmitPair`（`src/lib/rcPairState.ts`），防死锁回归。
 * 方案 C 之后发起侧不再有勾选框——那两个确认点原本要用户各做一次，而发起侧
 * 那次**防不住中间人**（论证见 `sync/invite.rs` 模块头）。
 */
import { useEffect, useRef, useState } from "react";
import { motion } from "framer-motion";
import { X } from "lucide-react";
import { FocusTrap } from "@/components/FocusTrap";
import { useDialogAnim } from "@/lib/dialogMotion";
import { useRcNearbyPair } from "@/hooks/useRcNearbyPair";
import { fingerprintOf } from "@/lib/fingerprint";
import type { UseRc } from "@/hooks/useRc";
import type { ToastFn } from "@/components/Toast";
import { RcPairModeSelect } from "./RcPairModeSelect";
import { RcPairCreatePane } from "./RcPairCreatePane";
import { RcPairPastePane } from "./RcPairPastePane";
import { RcPairPin } from "./RcPairPin";
import styles from "../rc/RemoteComputer.module.css";

export function RcPairDialog({
  rc,
  toast,
  onClose,
  onPairAccepted,
}: {
  rc: UseRc;
  toast: ToastFn;
  onClose: () => void;
  /**
   * 局域网配对成功那一刻的通知（乙方案 §6：完成屏已删——「配对成功的设备
   * 会自动出现在列表里」不该再多一次点击）。工作台拿它选中新设备；
   * 设置页不传，那边只 toast。
   */
  onPairAccepted?: (peerId: string) => void;
}) {
  const anim = useDialogAnim();
  const near = useRcNearbyPair();
  const [mode, setMode] = useState<"create" | "paste" | null>(null);
  const [name, setName] = useState(rc.identity?.device_name ?? "");
  const [created, setCreated] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);

  // 配对码倒计时（只在生成了码之后跑）。
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
        toast("配对码已复制，请发给对方", "success");
      } catch {
        toast("配对码已生成，请手动复制", "info");
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

  /**
   * 乙方案 §6：**完成屏删了**——成功那一刻关窗、toast、把新设备选出来。
   * `near.done` 由 `useRcNearbyPair` 按 `at_ms` 去重、一次会话只给一次，
   * 这个 ref 只是挂载内的第二道保险（effects 双跑时不弹两条 toast）。
   */
  const doneHandled = useRef(false);
  useEffect(() => {
    const d = near.done;
    if (!d || doneHandled.current) return;
    doneHandled.current = true;
    const name = d.peer_name.trim() || fingerprintOf(d.peer_id);
    toast(`已与「${name}」配对，设备已进列表${d.initiator ? "，点「连接」即可发起" : ""}`, "success");
    void rc.refreshTargets();
    onPairAccepted?.(d.peer_id);
    onClose();
    // 只跟 near.done 走：rc/toast/onClose 都是稳定引用，进依赖会让副作用被无关渲染重触发。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [near.done]);

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
            {near.pair ? (
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
                onPair={(n) =>
                  void near
                    .startPair(n.node_id)
                    .catch((e) => toast(stringify(e, "发起配对失败"), "error"))
                }
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
