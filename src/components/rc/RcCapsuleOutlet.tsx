/**
 * RcCapsuleOutlet — 会话内的**常驻结果出口条**（甲-②，2026-09-29）。
 *
 * 挂在 `.capZone` 的 flex 列里、`.capFloat` **之外**：`.capZone` 永不 `visibility:hidden`
 * （乙档起的分层），所以浮条收起、⋯ 面板关闭、甚至全屏态里 toast 不在 `.sessionWrap`
 * 子树而不可见（C1/C2 的同一个根），这条都照样在。规则 15.1 要求「触发常驻可见 ⇒ 结果
 * 常驻可见」，这条就是那句话的实现体。
 *
 * 只画**一条**（`rcOutletHead` 按紧迫度取头 + 计数），共用同一队列：
 * 远程改档 / 声音 / 剪贴板走 `rcOutcome`（toast + 入队），文件进度与乙-③ 的
 * 「对方收回了键鼠 / 锁定未生效」由这里**直接现算**——10Hz 的刷新值和「一条还在
 * 成立的状态」都不进队列，队列只存「说一次就够」的结果，否则一条进度会把别的结果
 * 全刷掉，而一条永久成立的状态被 ✕ 关掉就是撒谎。
 *
 * 成功也报（绿点 2s 自清）：只有失败才出现的条，会被用户读成「点了没反应」。
 */
import { useMemo } from "react";
import { X } from "lucide-react";
import { useRcFile } from "@/hooks/useRcFile";
import { useRcOutletStore, type RcOutletEntry } from "@/stores/rcOutletStore";
import { runProgress } from "@/lib/rcFile";
import { rcOutletHead } from "@/lib/rcOutlet";
import { rcHostHoldOutletOf } from "@/lib/rcInputGate";
import { rcPeerPausedOutletOf } from "@/lib/rcVideoPause";
import type { RcPeerInputState } from "@/lib/api/rc";
import styles from "./RemoteComputer.module.css";

type RcOutletKind = RcOutletEntry["kind"];

const kindCls: Record<RcOutletKind, string> = {
  ok: styles.capOutletOk,
  info: styles.capOutletInfo,
  bad: styles.capOutletBad,
  run: styles.capOutletRun,
};

export function RcCapsuleOutlet({
  peer,
  peerInput,
  peerVideoPaused,
}: {
  peer: string;
  /** 乙-③：对端报来的主机输入权状态（发起端侧的常驻行）。 */
  peerInput?: RcPeerInputState | null;
  /** 丙-③：对端暂停了向本机推送画面（常驻行的另一条落点——胶囊收起时它还在）。 */
  peerVideoPaused?: boolean;
}) {
  const entries = useRcOutletStore((s) => s.entries);
  const dismiss = useRcOutletStore((s) => s.dismiss);
  const file = useRcFile(peer || null);

  // 成员表达式不能直接进依赖数组（eslint 只认根对象，见 RcOverlay 同一处先例）：
  // 先把要用的三项取成局部名，依赖就写得准、也不会逼我们把整个 file 挂上去。
  const { tasks: fileTasks, rateOf, cancel: fileCancel } = file;

  // 进行中的文件传输：常驻一条 `run`，进度就地刷新（不进 store，见文件头注释）
  const runEntry = useMemo<RcOutletEntry | null>(() => {
    if (!peer) return null;
    const p = runProgress(fileTasks, rateOf);
    if (!p) return null;
    return {
      id: -1,
      kind: "run",
      label: p.label,
      detail: `${p.task.name} · ${p.rest}`,
      actionLabel: "取消",
      onAction: () => void fileCancel(p.task.id),
      pct: p.pct,
    };
  }, [peer, fileTasks, rateOf, fileCancel]);

  // 🔴 乙-③：两条「对方机器上的事实」也走现算（同 runEntry，负 id = ✕ 关不掉一条
  //   还在成立的状态）。收回期间浮条一收起，胶囊那枚琥珀 pill 就跟着 `.capFloat`
  //   隐形了——常驻的事实必须有常驻的落点（规则 15.1），这条就是那个落点。
  //   `err` 由对端下一帧无错自动清（锁定成功/失败都会重推），不需要 ✕。
  const stateEntries = useMemo<RcOutletEntry[]>(() => {
    if (!peer) return [];
    const out: RcOutletEntry[] = [];
    const hold = rcHostHoldOutletOf(peerInput);
    if (hold) out.push({ id: -2, kind: "info", label: hold.label, detail: hold.detail });
    // 丙-③：同款现算（负 id = ✕ 关不掉一条还在成立的状态，由对端下一帧
    // `vpause on=false` 自动清）。画面停帧时琥珀 pill 也藏在 `.capFloat` 里，
    // 而「对方现在看不到我」正是离开座位前最需要确认的一条。
    const paused = rcPeerPausedOutletOf(peerVideoPaused);
    if (paused) out.push({ id: -4, kind: "info", label: paused.label, detail: paused.detail });
    if (peerInput?.err) {
      out.push({ id: -3, kind: "bad", label: "锁定未生效", detail: peerInput.err });
    }
    return out;
  }, [peer, peerInput, peerVideoPaused]);

  const list = [...stateEntries, ...(runEntry ? [runEntry] : []), ...entries];
  const { head, rest } = rcOutletHead(list);
  if (!head) return null;

  const bad = head.kind === "bad";
  return (
    <div
      className={`${styles.capOutlet} ${kindCls[head.kind]}`}
      role={bad ? "alert" : "status"}
      aria-live={bad ? "assertive" : "polite"}
    >
      <span className={styles.capOutletDot} aria-hidden="true" />
      <span className={styles.capOutletText}>
        {head.label}
        {head.detail && <em className={styles.capOutletDetail}>{head.detail}</em>}
      </span>
      {/* 进度条宽度是唯一必须由数据决定的样式，其余颜色全走类名（规则 U8） */}
      {head.kind === "run" && typeof head.pct === "number" && (
        <span className={styles.capOutletBar} aria-hidden="true">
          {/* ui-rule-ok: 百分比进度只能由数据给，CSS 里没有这个值 */}
          <i style={{ width: `${head.pct}%` }} />
        </span>
      )}
      {head.actionLabel && head.onAction && (
        <button type="button" className={styles.capOutletAct} onClick={head.onAction}>
          {head.actionLabel}
        </button>
      )}
      {rest > 0 && <span className={styles.capOutletCnt} title={`还有 ${rest} 条`}>+{rest}</span>}
      {/* ✕ 只对队列里的那些（负 id = 现算的进度行，它由「传完」收尾，✕ 关不掉
          一条还在跑的进度才是说谎；要中止请用旁边的取消）。 */}
      {head.id >= 0 && (
        <button
          type="button"
          className={styles.capOutletX}
          aria-label="关闭提示"
          title="关闭提示"
          onClick={() => dismiss(head.id)}
        >
          <X size={11} aria-hidden="true" />
        </button>
      )}
    </div>
  );
}
