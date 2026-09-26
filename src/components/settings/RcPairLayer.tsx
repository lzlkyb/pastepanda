/**
 * RcPairLayer — 远程「配对 / 一次性协助」弹层的**唯一挂载点**。
 *
 * # 为什么单独立一个文件
 *
 * 抽出来之前，`RcWorkbench.tsx` 里内联了 `RcPairDialog` 的挂载与
 * 「把 `onStartRemote` 接到 `doRequest`」这段适配（该文件 285 行、红线 300）。
 * 方案甲要再挂一个弹层，直接加就过线了。
 *
 * 但真正的理由不是省行数，而是**这两个弹层有三种开到同一个地方**：
 * 工作台（有会话上下文，能真发起）与设置页（没有上下文，只能直发 `rc.request`）。
 * 适配「有没有 `onStartRemote`」这件事写两份，迟早有一处忘了传 —— 而忘了传
 * 的表现是「按钮点了没反应」，tsc 与单测都看不见。
 *
 * # 两种弹层为什么不分家
 *
 * `RcPairDialog`（长期）与 `RcAdhocDialog`（一次性）刻意是两个组件（语义不同，
 * 文案不能共用），但它们**总是同时被同一个入口状态驱动**，所以由本文件按 `mode`
 * 分派——调用方只需要一个 `useState`，不必管哪个 mode 归哪个组件。
 */
import type { UseRc } from "@/hooks/useRc";
import type { ToastFn } from "@/components/Toast";
import { RcPairDialog } from "./RcPairDialog";
import { RcAdhocDialog } from "./RcAdhocDialog";
import { RcUnoDialog } from "./RcUnoDialog";

/** `null` = 没有弹层。七种意图各占一个值，调用方不用再维护第二个布尔量。
    `help` = 方案 A 的「帮助一屏」：一个弹层里用页签收齐 helpMe / helpOther。 */
export type RcPairLayerMode =
  | "pair"
  | "helpMe"
  | "helpOther"
  | "help"
  | "unoGenerate"
  | "unoJoin"
  | "unoPass"
  | null;

export function RcPairLayer({
  rc,
  toast,
  mode,
  onClose,
  onStartRemote,
  onPairAccepted,
}: {
  rc: UseRc;
  toast: ToastFn;
  mode: RcPairLayerMode;
  onClose: () => void;
  /**
   * 发起会话的出口。**只有能发起会话的地方才传**（工作台）——设置页里的入口
   * 没有会话上下文，那时一次性协助退回 `rc.request` 直发「只看」。
   */
  onStartRemote?: (peerId: string) => void;
  /** 局域网配对成功那一刻选中新设备（工作台有设备页选中态才传）。 */
  onPairAccepted?: (peerId: string) => void;
}) {
  if (!mode) return null;
  if (mode === "pair") {
    return (
      <RcPairDialog
        rc={rc}
        toast={toast}
        onClose={onClose}
        onPairAccepted={onPairAccepted}
      />
    );
  }
  if (mode === "unoGenerate" || mode === "unoJoin" || mode === "unoPass") {
    const side = mode === "unoGenerate" ? "generate" : mode === "unoJoin" ? "join" : "pass";
    return <RcUnoDialog rc={rc} toast={toast} side={side} onClose={onClose} />;
  }
  return (
    <RcAdhocDialog
      rc={rc}
      toast={toast}
      mode={mode}
      onClose={onClose}
      onStartRemote={onStartRemote}
    />
  );
}
