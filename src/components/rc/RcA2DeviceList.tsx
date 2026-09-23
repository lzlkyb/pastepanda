/** 工作台侧栏：状态随设备常驻展示，列表顺序不随探测结果跳动。 */
import { useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Monitor, Plus, RotateCw, Search, ShieldAlert } from "lucide-react";
import type { RcCapability, RcTargetDevice } from "@/lib/api/rc";
import type { RcA2Page } from "@/lib/rcWorkbenchA2";
import type { RcReachability } from "@/stores/rcStoreTypes";
import { fingerprintOf } from "@/lib/fingerprint";
import { rcDisplayName } from "@/lib/rcDevice";
import { capabilityLabel } from "@/lib/rcRequest";
import { rcCheckTime, rcDeviceStatus } from "@/lib/utils";
import styles from "./RemoteComputerA2.module.css";

function targetName(target: RcTargetDevice): string {
  return rcDisplayName(target, fingerprintOf(target.node_id));
}

export function RcA2DeviceList({
  page, targets, selectedId, busy, locked, lockedLabel, reachability = {}, channelUp = true,
  targetsLoaded = true, targetsError = null, onSelect, onConnect, onRefresh, onPair, onNavigate,
  capFor, trustedOnly = false, onExitTrustedFilter,
}: {
  page: RcA2Page;
  targets: RcTargetDevice[];
  selectedId: string | null;
  busy: boolean;
  locked: boolean;
  lockedLabel: string;
  reachability?: Record<string, RcReachability>;
  channelUp?: boolean | null;
  targetsLoaded?: boolean;
  targetsError?: string | null;
  onSelect: (id: string) => void;
  onConnect: (id: string, capability: RcCapability) => void;
  onRefresh?: () => void;
  onPair: () => void;
  onNavigate: (page: RcA2Page) => void;
  /** 发起档取值口（useRcLaunch.capOf）：按设备记忆优先，全局默认兜底。 */
  capFor?: (id: string) => RcCapability;
  /** U10：只看免确认设备（设置页「管理」跳转进来的过滤态）。 */
  trustedOnly?: boolean;
  onExitTrustedFilter?: () => void;
}) {
  const [query, setQuery] = useState("");
  const [menuFor, setMenuFor] = useState<string | null>(null);
  /** U1：档位菜单的 fixed 定位（视口坐标）——挂在 ⌄ 下方、右缘对齐。 */
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  const filtered = useMemo(() => {
    const base = trustedOnly ? targets.filter((t) => t.trusted) : targets;
    const keyword = query.trim().toLocaleLowerCase();
    if (!keyword) return base;
    return base.filter((target) =>
      `${targetName(target)} ${target.name} ${target.node_id}`.toLocaleLowerCase().includes(keyword),
    );
  }, [query, targets, trustedOnly]);
  const checkingCount = targets.filter((target) => reachability[target.node_id]?.state === "checking").length;
  const trustedCount = targets.filter((target) => target.trusted).length;

  return (
    <>
      <div className={styles.sidebarHead}>
        {trustedOnly && (
          <div className={styles.trustedFilterBar} role="status">
            <ShieldAlert size={13} aria-hidden="true" />
            <span>
              正在查看：<b>免确认设备（{trustedCount} 台）</b>
            </span>
            <button type="button" onClick={onExitTrustedFilter}>
              显示全部设备
            </button>
          </div>
        )}
        <div className={styles.sidebarTitleRow}>
          <h2>我的设备</h2>
          <button type="button" className={styles.secondaryButton} onClick={onPair}>
            <Plus size={14} aria-hidden="true" />添加设备
          </button>
        </div>
        <label className={styles.searchBox}>
          <Search size={14} aria-hidden="true" />
          <input type="search" value={query} onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索设备" aria-label="搜索设备" />
        </label>
        <div className={styles.deviceListMeta}>
          <span>{targets.length} 台设备 · {channelUp === null
            ? "正在获取状态"
            : channelUp ? checkingCount > 0 ? `正在确认 ${checkingCount} 台` : "状态自动更新"
              : "通道未启动"}</span>
          {onRefresh && <button type="button" onClick={onRefresh}>
            <RotateCw size={12} aria-hidden="true" />重新检查
          </button>}
        </div>
      </div>

      <div className={styles.deviceList}>
        {targetsError && <div className={styles.deviceLoadError} role="alert">
          <strong>设备列表暂时无法加载</strong>
          <span>{targets.length > 0 ? "请重新检查。已有设备仍可尝试连接。" : "请重新检查设备列表。"}</span>
          {onRefresh && <button type="button" onClick={onRefresh}>重试</button>}
        </div>}
        {!targetsLoaded && !targetsError && targets.length === 0 ? (
          /* 质感升级 3.3：shimmer 骨架替代纯文本「正在加载设备…」的静默等待 */
          <div className={styles.skeletonBlock} role="status" aria-label="正在加载设备">
            <div className={styles.skeletonRow} />
            <div className={styles.skeletonRow} />
            <div className={styles.skeletonRow} />
          </div>
        ) : !targetsError && targets.length === 0 ? (
          <div className={styles.sidebarEmpty}>
            <Monitor size={22} aria-hidden="true" />
            <p>还没有已配对的设备</p>
            <span>添加后会显示在这里，以后可以直接连接。</span>
          </div>
        ) : trustedOnly && trustedCount === 0 ? (
          <div className={styles.sidebarEmpty}>
            <p>还没有免确认设备</p>
            <span>在被控确认条或设备管理里开启后，会显示在这里。</span>
          </div>
        ) : targets.length === 0 ? null : filtered.length === 0 ? (
          <div className={styles.sidebarEmpty}><p>没有匹配的设备</p><span>换个名称或指纹前缀试试。</span></div>
        ) : filtered.map((target) => {
          const name = targetName(target);
          const selected = target.node_id === selectedId;
          const status: ReturnType<typeof rcDeviceStatus> = target.source === "rc"
            ? rcDeviceStatus(target.presence, reachability[target.node_id], channelUp)
            // L4（2026-09-23 审计）：这是用户第一次撞见「远程配对」这个词——
            // 就地补一句它和同步配对的关系，别只留一个看不懂的门槛。
            : { label: "需完成远程配对（仅同步的配对还不能远程控制本机）", tone: "unknown" as const };
          const unavailable = target.source !== "rc" || locked;
          const menuOpen = menuFor === target.node_id;
          // 该行的发起档：按设备记忆优先，没记过落全局默认（2026-09-23 之前是全局单值，给一台选档会串到所有行）
          const rowCap = capFor ? capFor(target.node_id) : "control";
          return (
            <div key={target.node_id}
              className={`${styles.deviceItem} ${selected ? styles.deviceItemSelected : ""}`}>
              <button type="button" className={styles.deviceSelect}
                aria-label={`选择设备“${name}”`} aria-pressed={selected}
                onClick={() => {
                  onSelect(target.node_id);
                  if (page !== "devices" && page !== "files") onNavigate("devices");
                }}>
                <span className={styles.deviceIcon} data-tone={status.tone}>
                  <Monitor size={16} aria-hidden="true" />
                </span>
                <span className={styles.deviceCopy}>
                  <strong>{name}</strong>
                  <small data-tone={status.tone}>
                    {/* U5：被禁止的设备行上直接可见，不用进详情面才知道 */}
                    {target.denied && (
                      <span className={styles.deniedTag}>
                        <ShieldAlert size={10} aria-hidden="true" />
                        已禁止连接本机
                      </span>
                    )}
                    {status.label}{status.checkedAt && ` · ${rcCheckTime(status.checkedAt)} 检查`}
                    {target.trusted && " · 免确认已开启"}
                  </small>
                </span>
              </button>
              <span className={styles.connectGroup}>
                <button type="button"
                  className={target.denied ? styles.connectButtonSec : styles.connectButton}
                  aria-label={`连接${name}`}
                  title={
                    unavailable
                      ? (target.source !== "rc" ? "请先完成远程配对" : lockedLabel)
                      : target.denied
                        ? `这台设备已被你禁止远程本机；你仍可主动连接。将以「${capabilityLabel(rowCap)}」发起`
                        : `将以「${capabilityLabel(rowCap)}」发起：连接${name}`
                  }
                  disabled={busy || unavailable}
                  onClick={() => onConnect(target.node_id, rowCap)}>
                  {target.denied ? "已禁止" : `连接 · ${capabilityLabel(rowCap)}`}
                </button>
                <button type="button"
                  className={target.denied ? styles.connectCaretSec : styles.connectCaret}
                  aria-label={`选择${name}的发起档位`} aria-expanded={menuOpen}
                  title="选择发起档位"
                  disabled={busy || unavailable}
                  onClick={(e) => {
                    const r = e.currentTarget.getBoundingClientRect();
                    setMenuPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
                    setMenuFor(menuOpen ? null : target.node_id);
                  }}>
                  <ChevronDown size={10} aria-hidden="true" />
                </button>
              </span>
              {menuOpen && menuPos &&
                /* 🔴 浮层必须 portal 到 body：设备行 hover 有 translateY(-1px)、
                   入场有 stagger 动画——任何带 transform 的祖先都会成为行内
                   position:fixed 的定位基准（视口坐标全部错位、inset:0 背板
                   只盖一行）。2026-09-23 质感升级加 hover 浮起后实测回归。 */
                createPortal(
                  <>
                    {/* 透明背板：点外即收；挡住滚轮让列表不滚，fixed 菜单因此不漂移 */}
                    <div className={styles.menuBackdrop} onClick={() => setMenuFor(null)} />
                    <div className={styles.capMenu} role="menu" aria-label="发起档位"
                      style={{ top: menuPos.top, right: menuPos.right }}>
                      {([
                        ["control", "可控", "对方可操作键鼠与剪贴板"],
                        ["view", "只看", "仅查看画面，不能操作"],
                      ] as [RcCapability, string, string][]).map(([value, label, hint]) => (
                        <button key={value} type="button" role="menuitem"
                          onClick={() => {
                            setMenuFor(null);
                            onConnect(target.node_id, value);
                          }}>
                          {rowCap === value
                            ? <em className={styles.capMark}>●</em>
                            : <em className={styles.capMarkOff}>○</em>}
                          {label}{rowCap === value ? "（默认）" : ""}
                          <small>{hint}</small>
                        </button>
                      ))}
                    </div>
                  </>,
                  document.body,
                )}
            </div>
          );
        })}
      </div>
    </>
  );
}
