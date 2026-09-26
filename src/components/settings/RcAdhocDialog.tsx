/**
 * RcAdhocDialog — 「一次性协助」的壳（方案甲）。两种意图共用一套外壳：
 *
 * - `helpMe`   「让别人帮我」：出码给对方 → 对方连过来（被协助方，1 步）
 * - `helpOther`「帮别人连一次」：粘对方的码 → 直接连（协助方，2 步）
 *
 * # 为什么单独立壳，不塞进 RcPairDialog
 *
 * `RcPairDialog` 已经是「4 屏状态 + 局域网过滤 + 邀请码两条路」的容器（236 行），
 * 再加两种流程就是 6 屏；更要紧的是**两套语义不该共用一套文案**——
 * 长期配对那套说的是「配对」，一次性这套说的是「这一次」，混在一个壳里
 * 迟早会在某屏说错话（本文件的两个标题就是这么分开的）。
 *
 * # 🔴 协助方「2 步」是怎么成立的
 *
 * `pair()` 成功**不进** `RcPairDone` 完成屏，直接发起会话：配对完的第一意图
 * 几乎总是「马上连过去」，而完成屏还要再点一次「立刻发起远程」。
 * 前提是后端允许 `pair → request` 连续执行——已核实：`rc_pair` 内部
 * `svc.start()` 是 **await** 的（`commands/rc.rs:342`），返回时通道已起；
 * `rc_request_session` 只要求 `is_running()`。启动失败不 panic 只 warn，
 * 那时 request 会拿到「远程通道未启动」这句可照做的错误，不会静默失败。
 *
 * # 能力档固定「只看」
 *
 * 一次性协助的入口刻意不给能力档选择（1:1 稿里也没有）：多一个选择就多一步，
 * 而「只看」是保守的那一侧。协助方真需要动手时，会话内已有的
 * 「提权为可控」（结束 + 重新申请）就是现成的出口（`RcSessionView.onRequestControl`）。
 */
import { useEffect, useState } from "react";
import { motion } from "framer-motion";
import { X } from "lucide-react";
import { FocusTrap } from "@/components/FocusTrap";
import { useDialogAnim } from "@/lib/dialogMotion";
import { DEFAULT_REQUEST_CAP, rememberRequestCap } from "@/lib/rcRequest";
import { fingerprintOf } from "@/lib/fingerprint";
import type { UseRc } from "@/hooks/useRc";
import type { ToastFn } from "@/components/Toast";
import { RcAdhocCodePane } from "./RcAdhocCodePane";
import { RcPairPastePane } from "./RcPairPastePane";
import styles from "../rc/RemoteComputer.module.css";

export type AdhocMode = "helpMe" | "helpOther" | "help";

/** 「help」= 方案 A 的「帮助一屏」：一个壳里用页签收齐下面两种意图。 */
type HelpTab = Exclude<AdhocMode, "help">;

export function RcAdhocDialog({
  rc,
  toast,
  mode,
  onClose,
  onStartRemote,
}: {
  rc: UseRc;
  toast: ToastFn;
  mode: AdhocMode;
  onClose: () => void;
  /**
   * 发起会话的出口。工作台传得进来（顺带拿到撤销窗口与能力档记忆）；
   * 设置页没有会话上下文，不传 —— 那时退回 `rc.request` 直发「只看」。
   */
  onStartRemote?: (peerId: string) => void;
}) {
  const anim = useDialogAnim();
  const [tab, setTab] = useState<HelpTab>("helpMe");
  const [code, setCode] = useState<string | null>(null);
  const [expiresAt, setExpiresAt] = useState(0);
  const [now, setNow] = useState(Date.now());
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState("");

  const generate = async () => {
    setBusy(true);
    setErr("");
    try {
      const r = await rc.createInvite(rc.identity?.device_name ?? "");
      setCode(r.code);
      setExpiresAt(r.expires_at);
      setNow(Date.now());
      try {
        await navigator.clipboard.writeText(r.code);
        toast("帮助码已复制，发给帮你的人", "success");
      } catch {
        toast("帮助码已生成，请手动复制", "info");
      }
    } catch (e) {
      setErr(typeof e === "string" ? e : e instanceof Error ? e.message : "生成失败");
    } finally {
      setBusy(false);
    }
  };

  // 实际渲染的是哪一屏：独立入口看 `mode`，「帮助一屏」看当前页签。
  const pane: HelpTab = mode === "help" ? tab : mode;

  // 点开即出码（「1 步」就是这一步被省掉的）。只在被协助方那一屏跑。
  useEffect(() => {
    if (pane === "helpMe" && !code) void generate();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pane]);

  // 码的剩余时间：只在有码之后跑计时器，关掉即清。
  useEffect(() => {
    if (!code || !expiresAt) return;
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [code, expiresAt]);

  /** 协助方：配对成功后的唯一收尾——直接发起，跳过完成屏。 */
  const handleAdhocPaired = (peerId: string, peerName: string) => {
    rememberRequestCap(DEFAULT_REQUEST_CAP);
    const name = peerName.trim() || fingerprintOf(peerId);
    if (onStartRemote) {
      onStartRemote(peerId);
      toast(`已向「${name}」发起连接`, "success");
    } else {
      // 设置页没有工作台的发起链路，直发「只看」；失败仍由 rc.error 行显示。
      void rc.request(peerId, DEFAULT_REQUEST_CAP).then((ok) => {
        if (ok) toast(`已向「${name}」发起连接`, "success");
      });
    }
    onClose();
  };

  return (
    <motion.div key="rc-adhoc" {...anim.backdrop} className="dialog-backdrop" onClick={onClose}>
      <FocusTrap>
        <motion.div
          {...anim.panel}
          className="dialog-box"
          style={{ width: "min(480px, 94vw)" }}
          onClick={(e) => e.stopPropagation()}
        >
          <div className="dialog-header">
            <h2 className="dialog-title">
              {mode === "help" ? "帮助" : mode === "helpMe" ? "让别人帮我" : "帮别人连一次"}
            </h2>
            <button className="dialog-close" onClick={onClose} aria-label="关闭">
              <X size={15} />
            </button>
          </div>
          {mode === "help" && (
            <div className={styles.adhocTabs} role="tablist" aria-label="协助方式">
              {(["helpMe", "helpOther"] as const).map((t) => (
                <button
                  key={t}
                  type="button"
                  role="tab"
                  aria-selected={pane === t}
                  className={pane === t ? styles.adhocTabOn : undefined}
                  onClick={() => setTab(t)}
                >
                  {t === "helpMe" ? "让别人帮我" : "帮别人连一次"}
                </button>
              ))}
            </div>
          )}
          <div className={styles.body}>
            {pane === "helpMe" ? (
              <RcAdhocCodePane
                code={code}
                expiresAt={expiresAt}
                now={now}
                busy={busy}
                error={err}
                toast={toast}
                onGenerate={generate}
                onBack={onClose}
              />
            ) : (
              <RcPairPastePane
                previewInvite={rc.previewInvite}
                pair={rc.pair}
                selfNodeId={rc.identity?.node_id}
                toast={toast}
                adhoc
                onBack={onClose}
                onPaired={() => onClose()}
                onAdhocPaired={handleAdhocPaired}
              />
            )}
            {/* 乙方案 §2 回程互链：停在「帮助」的人里有一部分其实只是要连回老设备——
                去程（向导 → 帮助）已有提示，这里补反向的出口指路。 */}
            <div className={styles.foot}>
              要连回已配对的设备？关掉本窗，在左侧「我的设备」里直接选它。
            </div>
          </div>
        </motion.div>
      </FocusTrap>
    </motion.div>
  );
}
