/**
 * RcDeviceList — 设备列表**容器**：只负责遍历与传参，行渲染在 `RcDeviceRow`。
 *
 * 拆分的直接原因：本文件曾同时干「遍历列表」和「画一行 + 菜单 + 改名 + 四个动作」，
 * 涨到 329 行，超了 .tsx ≤ 300 的红线。行内的交互纪律（控件 stopPropagation、
 * 会话中锁发起、四档可达性）见 RcDeviceRow 顶部说明。
 *
 * 设备有两类，混在同一张列表里：
 * - 远程配对设备（`source === "rc"`）：可以发起远程；
 * - 纯同步配对设备（`source === "sync"`）：只列得出、发不起，给出「去配对」出口（B9）。
 */
import type { RcCapability, RcTargetDevice } from "@/lib/api/rc";
import { RcDeviceRow } from "./RcDeviceRow";
import styles from "./RemoteComputer.module.css";

export function RcDeviceList({
  targets,
  lastPeer,
  deviceDeny,
  busy,
  locked,
  lockedLabel,
  requestCap,
  onRequest,
  onRequestWith,
  onForget,
  onSetAllowed,
  onTrustToggle,
  onRename,
  onPair,
  toast,
}: {
  targets: RcTargetDevice[];
  lastPeer: string | null;
  deviceDeny: Record<string, boolean>;
  busy: boolean;
  /** 有会话进行中：发起类操作全部锁住（后端只有一个会话位）。 */
  locked: boolean;
  lockedLabel: string;
  requestCap: RcCapability;
  onRequest: (id: string) => void;
  /** ⋯ 菜单里显式指定档发起——原「申请卡」的选档职能，改成按需展开。 */
  onRequestWith: (id: string, cap: RcCapability) => void;
  onForget: (id: string) => Promise<boolean>;
  onSetAllowed: (id: string, allowed: boolean) => Promise<boolean>;
  /** A1：切换「免确认直连」（返回 false 时调用方已 toast）。 */
  onTrustToggle: (id: string, trusted: boolean) => Promise<boolean>;
  /** A1：保存备注名。返回 false 时编辑框保持打开。 */
  onRename: (id: string, note: string) => Promise<boolean>;
  /** B9：纯同步配对设备「列得出却发不起」，给一个去完成远程配对的入口。 */
  onPair?: () => void;
  toast: (m: string, k: "success" | "error" | "info") => void;
}) {
  return (
    <div className={styles.devList}>
      {targets.map((d) => (
        <RcDeviceRow
          key={d.node_id}
          d={d}
          lastPeer={lastPeer}
          deviceDeny={deviceDeny}
          busy={busy}
          locked={locked}
          lockedLabel={lockedLabel}
          requestCap={requestCap}
          onRequest={onRequest}
          onRequestWith={onRequestWith}
          onForget={onForget}
          onSetAllowed={onSetAllowed}
          onTrustToggle={onTrustToggle}
          onRename={onRename}
          onPair={onPair}
          toast={toast}
        />
      ))}
    </div>
  );
}
