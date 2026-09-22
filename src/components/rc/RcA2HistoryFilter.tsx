/**
 * RcA2HistoryFilter — 记录页的侧栏上半部：「按设备筛选」。
 *
 * A2 稿（设备优先工作台）的 history 屏把侧栏从设备列表换成按设备筛选——理由是
 * 记录页的真问题是「哪台设备的记录」，而设备列表在这里只能干看着、点一下还会
 * 跳走。本组件补这一形态，形状与设备列表一致（同一套 deviceItem 类）以免侧栏
 * 在换页时整体跳一下。
 *
 * 计数与「全部设备」那一项都来自同一份历史快照（`RcWorkbench` 的 useRcHistory），
 * 所以「全部 12 条」与各设备之和恒等；各设备行右侧照常显示该设备的当前可达性
 * （取不到就不显示，不编状态）。
 */
import type { ReactNode } from "react";
import { History, Monitor } from "lucide-react";
import type { RcTargetDevice } from "@/lib/api/rc";
import { normalizeRcPresence } from "@/lib/rcDevice";
import type { RcHistoryDevice } from "@/lib/rcHistory";
import styles from "./RemoteComputerA2.module.css";

export function RcA2HistoryFilter({
  devices,
  total,
  peer,
  targets,
  onSelect,
  onBack,
}: {
  devices: RcHistoryDevice[];
  /** 全部记录条数（= 各设备之和，同一份快照）。 */
  total: number;
  /** 当前筛的设备（node_id），null = 全部设备。 */
  peer: string | null;
  /** 用于显示各设备当前可达性；已从配对列表移除的设备查不到，就不显示点。 */
  targets: RcTargetDevice[];
  onSelect: (peer: string | null) => void;
  onBack: () => void;
}) {
  const presenceOf = (key: string): string | null => {
    const target = targets.find((t) => t.node_id === key);
    return target ? normalizeRcPresence(target.presence) : null;
  };

  return (
    <>
      <div className={styles.sidebarHead}>
        <div className={styles.sidebarTitleRow}>
          <h2>我的设备</h2>
          <button type="button" className={styles.secondaryButton} onClick={onBack}>
            返回设备
          </button>
        </div>
      </div>

      <div className={styles.deviceList}>
        {total === 0 ? (
          <div className={styles.sidebarEmpty}>
            <History size={22} aria-hidden="true" />
            <p>还没有会话记录</p>
            <span>远程过一次之后，就能按设备回看。</span>
          </div>
        ) : (
          <>
            <div className={styles.listLabel} aria-hidden="true">
              <span>按设备筛选</span>
            </div>
            <FilterRow
              name="全部设备"
              sub={`${total} 条会话记录`}
              selected={peer === null}
              icon={<History size={17} aria-hidden="true" />}
              onSelect={() => onSelect(null)}
            />
            {devices.map((d) => (
              <FilterRow
                key={d.key}
                name={d.label}
                sub={`${d.count} 条记录`}
                selected={peer === d.key}
                presence={presenceOf(d.key)}
                icon={<Monitor size={17} aria-hidden="true" />}
                onSelect={() => onSelect(d.key)}
              />
            ))}
          </>
        )}
      </div>
    </>
  );
}

function FilterRow({
  name,
  sub,
  selected,
  presence,
  icon,
  onSelect,
}: {
  name: string;
  sub: string;
  selected: boolean;
  /** null = 这台不在配对列表里（已移除），不显示状态点。 */
  presence?: string | null;
  icon: ReactNode;
  onSelect: () => void;
}) {
  return (
    <div className={`${styles.deviceItem} ${selected ? styles.deviceItemSelected : ""}`}>
      <button
        type="button"
        className={styles.deviceSelect}
        aria-label={`按设备筛选：${name}，${sub}`}
        aria-pressed={selected}
        onClick={onSelect}
      >
        <span className={styles.deviceIcon} data-presence={presence ?? undefined}>
          {icon}
        </span>
        <span className={styles.deviceCopy}>
          <strong>{name}</strong>
          <small>{sub}</small>
        </span>
      </button>
    </div>
  );
}
