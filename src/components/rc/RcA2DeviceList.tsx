/**
 * RcA2DeviceList — A2 侧栏的上半部：标题行 + 搜索 + 设备列表（分组）。
 *
 * 从 `RcA2Sidebar` 拆出（2026-09-21 批4 加分组时）：侧栏还要管配对入口、被连接
 * 开关、一次性协助按钮与工具导航，而设备列表连自己的搜索状态是自洽的一块。
 *
 * 两条与稿的实现约定（都写进设计稿实施备注）：
 *  1. **分三组不是两组**：在线 / 最近使用 / 尚未连接。稿只画了两组，但后端可达性
 *     是四档，`never`（配对后从没连上过）不属于「最近使用」。见 `groupRcTargets`。
 *  2. **第二行给实测路径，不给状态**：状态已经写在分组标题上（见 `deviceRowSubLabel`）。
 *     被让位的那条信息（在线行的上次时间 / 离线行的上次路径）进 `title` 补回。
 *
 * 搜索**不拆散分组**：有搜索词时仍按组渲染，否则结果的语境（这台在不在线）会丢。
 */
import { useMemo, useState } from "react";
import { Monitor, Plus, Search } from "lucide-react";
import type { RcCapability, RcTargetDevice } from "@/lib/api/rc";
import type { RcA2Page } from "@/lib/rcWorkbenchA2";
import { fingerprintOf } from "@/lib/fingerprint";
import {
  deviceRowSubLabel,
  groupRcTargets,
  normalizeRcPresence,
  rcDisplayName,
  relTime,
} from "@/lib/rcDevice";
import { pathKindLabel } from "@/lib/rcSessionStats";
import styles from "./RemoteComputerA2.module.css";

function targetName(target: RcTargetDevice): string {
  return rcDisplayName(target, fingerprintOf(target.node_id));
}

export function RcA2DeviceList({
  page,
  targets,
  selectedId,
  busy,
  locked,
  lockedLabel,
  onSelect,
  onConnect,
  onProbe,
  onPair,
  onNavigate,
}: {
  page: RcA2Page;
  targets: RcTargetDevice[];
  selectedId: string | null;
  busy: boolean;
  locked: boolean;
  lockedLabel: string;
  onSelect: (id: string) => void;
  onConnect: (id: string, capability: RcCapability) => void;
  /** 批7：单台探测（离线设备行那格「检测」）。返回 Promise 以便按行显示「检测中」。 */
  onProbe: (id: string) => Promise<unknown>;
  onPair: () => void;
  onNavigate: (page: RcA2Page) => void;
}) {
  const [query, setQuery] = useState("");
  /* 正在探测的那些台。只影响该行按钮文案，所以收在这一层——为一个行内瞬时态把
     state 提到 RcWorkbench 再透传下来不划算。
     🔴 **必须是集合不是单值**（2026-09-22 实证后改）：多台可以同时在拨号，单值时
     先返回的那台的 `finally` 会把后一台的「检测中」一起清掉——表现是乙仍在飞行中
     却变回可点的「检测」，用户再点一次就对同一台并发拨两遍。 */
  const [probingIds, setProbingIds] = useState<ReadonlySet<string>>(() => new Set());
  const filtered = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    if (!keyword) return targets;
    return targets.filter((target) =>
      `${targetName(target)} ${target.name} ${target.node_id}`.toLocaleLowerCase().includes(keyword),
    );
  }, [query, targets]);
  const groups = useMemo(() => groupRcTargets(filtered), [filtered]);

  return (
    <>
      <div className={styles.sidebarHead}>
        <div className={styles.sidebarTitleRow}>
          <h2>我的设备</h2>
          <button type="button" className={styles.secondaryButton} onClick={onPair}>
            <Plus size={14} aria-hidden="true" />
            添加设备
          </button>
        </div>
        <label className={styles.searchBox}>
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索设备"
            aria-label="搜索设备"
          />
        </label>
      </div>

      <div className={styles.deviceList}>
        {targets.length === 0 ? (
          <div className={styles.sidebarEmpty}>
            <Monitor size={22} aria-hidden="true" />
            <p>还没有已配对的设备</p>
            <span>添加后会显示在这里，以后可以直接连接。</span>
          </div>
        ) : filtered.length === 0 ? (
          <div className={styles.sidebarEmpty}>
            <p>没有匹配的设备</p>
            <span>换个名称或指纹前缀试试。</span>
          </div>
        ) : (
          groups.map((group) => (
            /* 分组标题视觉上是「在线 2」两列，语义上是一个具名组：屏幕阅读器从
               aria-label 读到「在线，2 台设备」，列表项归属明确。 */
            <div
              key={group.key}
              role="group"
              aria-label={`${group.label}，${group.items.length} 台设备`}
            >
              <div className={styles.listLabel} aria-hidden="true">
                <span>{group.label}</span>
                <span>{group.items.length}</span>
              </div>
              {group.items.map((target) => {
                const name = targetName(target);
                const selected = target.node_id === selectedId;
                const presence = normalizeRcPresence(target.presence);
                const lastSeen = relTime(target.last_seen);
                const path = pathKindLabel(target.last_path ?? "");
                const sub = deviceRowSubLabel(presence, lastSeen, path);
                /* 第二行只能放一条信息，被让位的那条进 title —— 省掉的信息必须有
                   地方补回（同 RcDeviceRow 图标按钮的 aria-label + title 成对纪律）。 */
                const subHint =
                  presence === "live"
                    ? lastSeen
                      ? `上次连接 ${lastSeen}`
                      : undefined
                    : path
                      ? `上次实测路径：${path}`
                      : undefined;
                const unavailable = target.source !== "rc" || locked;
                /* 批7：右格按在线与否分流，照 A 方案稿——在线给「连接」（主操作，稿子
                   是 primary-button），离线给「检测」（先确认还在不在，稿子是 text-button）。
                   探测通过后 presence 变 live，下一轮渲染这一格会**自己**换成「连接」，
                   不需要手动切换状态。 */
                const online = presence === "live";
                const probingThis = probingIds.has(target.node_id);
                return (
                  <div
                    key={target.node_id}
                    className={`${styles.deviceItem} ${selected ? styles.deviceItemSelected : ""}`}
                  >
                    <button
                      type="button"
                      className={styles.deviceSelect}
                      aria-label={`选择设备“${name}”`}
                      aria-pressed={selected}
                      onClick={() => {
                        onSelect(target.node_id);
                        if (page !== "devices" && page !== "files") onNavigate("devices");
                      }}
                    >
                      <span className={styles.deviceIcon} data-presence={presence}>
                        <Monitor size={16} aria-hidden="true" />
                      </span>
                      <span className={styles.deviceCopy}>
                        <strong>{name}</strong>
                        <small title={subHint}>{sub}</small>
                      </span>
                    </button>
                    {online ? (
                      <button
                        type="button"
                        className={styles.connectButton}
                        aria-label={`连接${name}`}
                        title={
                          unavailable ? lockedLabel || "此设备当前不可连接" : `连接并控制${name}`
                        }
                        disabled={busy || unavailable}
                        onClick={() => onConnect(target.node_id, "control")}
                      >
                        连接
                      </button>
                    ) : (
                      /* 检测只回答「这台还在不在」——比直接发起一次会失败的会话便宜。
                         门禁只看 locked：探测是拨号，仅同步配对的设备同样能拨。 */
                      <button
                        type="button"
                        className={styles.probeButton}
                        aria-label={`检测“${name}”是否可达`}
                        title="确认这台设备现在是否可达；探测通过后这一格会变成「连接」"
                        disabled={locked || probingThis}
                        onClick={() => {
                          /* 加 / 删都按 id，互不干扰：先结束的那台只摘掉自己。 */
                          setProbingIds((prev) => new Set(prev).add(target.node_id));
                          void onProbe(target.node_id).finally(() =>
                            setProbingIds((prev) => {
                              const next = new Set(prev);
                              next.delete(target.node_id);
                              return next;
                            }),
                          );
                        }}
                      >
                        {probingThis ? "检测中" : "检测"}
                      </button>
                    )}
                  </div>
                );
              })}
            </div>
          ))
        )}
      </div>
    </>
  );
}
