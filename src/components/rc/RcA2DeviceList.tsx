/** 工作台侧栏：分组展示在线/不在线；行内零按钮（方案 3），点行 = 选中，连接只走详情面 hero 大钮。
 *
 * 行密度对齐 RustDesk peer_card.dart（2026-09-26 调研，设计稿
 * `design/远程电脑-设备行对齐RustDesk-前后对比-设计稿.html`）：
 *  - 状态点（头像角 `deviceIcon::after`）承担「在线与否」——组名已表达，行内不再复述；
 *    行上只留组名覆盖不了的差异词（刚刚可连接 / 未实测 / 正在确认 / 待完成配对）。
 *  - 属性图标化：免确认 = 绿钥匙盾（对应 RustDesk 的 Icons.key 叠角）、已禁止 = 红盾，
 *    全称进 title；档位预告与检查时间也进 title（hero 分体大钮上仍是常驻预告位）。
 *  - 搜索 = 常驻放大镜点开才出输入框（peer_tab_page.dart 同款，无设备数阈值）。
 */
import { useMemo, useState } from "react";
import { ChevronRight, Monitor, Plus, RotateCw, Search, ShieldAlert, ShieldCheck, X } from "lucide-react";
import type { RcTargetDevice } from "@/lib/api/rc";
import type { RcA2Page } from "@/lib/rcWorkbenchA2";
import type { RcReachability } from "@/stores/rcStoreTypes";
import { fingerprintOf } from "@/lib/fingerprint";
import { rcDisplayName } from "@/lib/rcDevice";
import { capabilityLabel } from "@/lib/rcRequest";
import { tagColorOf, tagSummaryOf } from "@/lib/rcDeviceTags";
import { rcCheckTime, rcDeviceStatus } from "@/lib/utils";
import { RcA2TagFilterRow } from "./RcA2TagFilterRow";
import styles from "./RemoteComputerA2.module.css";

function targetName(target: RcTargetDevice): string {
  return rcDisplayName(target, fingerprintOf(target.node_id));
}

/** 分组判据（A 稿变体 B）：tone==="ok" 进「在线」；组名用「不在线」不用「离线」——
    「最近在线 · 未实测」进后者不算撒谎。组内顺序保持原列表序，不随探测结果跳动。 */
type RowView = {
  target: RcTargetDevice;
  name: string;
  status: ReturnType<typeof rcDeviceStatus>;
  /** 行上显示的短状态词；长句（如同步配对的解释）只进 title。 */
  shortLabel: string;
  /** 悬停补全：档位预告 + 检查时间 + 被撤下长句。 */
  tip: string;
  online: boolean;
};

export function RcA2DeviceList({
  page, targets, selectedId, reachability = {}, channelUp = true,
  targetsLoaded = true, targetsError = null, onSelect, onRefresh, onPair, onNavigate,
  capFor, trustedOnly = false, onExitTrustedFilter,
}: {
  page: RcA2Page;
  targets: RcTargetDevice[];
  selectedId: string | null;
  reachability?: Record<string, RcReachability>;
  channelUp?: boolean | null;
  targetsLoaded?: boolean;
  targetsError?: string | null;
  onSelect: (id: string) => void;
  onRefresh?: () => void;
  onPair: () => void;
  onNavigate: (page: RcA2Page) => void;
  /** 发起档取值口（useRcLaunch.capOf）：行 meta 预告「以哪档连接」——行钮删除后这是档位唯一的常驻预告位。 */
  capFor?: (id: string) => import("@/lib/api/rc").RcCapability;
  /** U10：只看免确认设备（设置页「管理」跳转进来的过滤态）。 */
  trustedOnly?: boolean;
  onExitTrustedFilter?: () => void;
}) {
  /* 搜索框已删「按设备数条件出现」的旧拍板，改对齐 RustDesk：放大镜常驻、点开才出输入框。
     折叠态按组名记：只记用户主动折过的组，默认全展开。 */
  const [folded, setFolded] = useState<Record<string, boolean>>({});
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState("");
  // 标签筛选（对齐稿①）：多选、任一命中（OR）；只有存在带标签设备时 chip 行才出现
  const [tagFilter, setTagFilter] = useState<string[]>([]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    const byQuery = q ? targets.filter((t) => targetName(t).toLowerCase().includes(q)) : targets;
    const byTag = tagFilter.length
      ? byQuery.filter((t) => (t.tags ?? []).some((tag) => tagFilter.includes(tag.name)))
      : byQuery;
    return trustedOnly ? byTag.filter((t) => t.trusted) : byTag;
  }, [targets, trustedOnly, query, tagFilter]);
  const rows = useMemo<RowView[]>(
    () => filtered.map((target) => {
      const status: ReturnType<typeof rcDeviceStatus> = target.source === "rc"
        ? rcDeviceStatus(target.presence, reachability[target.node_id], channelUp)
        // L4（2026-09-23 审计）：就地解释——行上摆短词，全句进 title
        : { label: "待完成远程配对", tone: "unknown" as const };
      const capTip = target.source === "rc" ? `将以「${capabilityLabel(capFor ? capFor(target.node_id) : "control")}」连接` : "";
      const tagTip = tagSummaryOf(target.tags);
      const tip = [
        target.source !== "rc" && "仅同步的配对还不能远程控制本机，完成远程配对后即可",
        capTip,
        status.checkedAt && `${rcCheckTime(status.checkedAt)} 检查`,
        target.denied && "已禁止连接本机",
        target.trusted && "免确认已开启",
        // 行上「每行最多两段文字」不变式：标签与描述备注只走悬停（对齐稿①）
        target.remark && `备注：${target.remark}`,
        tagTip,
      ].filter(Boolean).join(" · ");
      return { target, name: targetName(target), status, shortLabel: status.label, tip, online: status.tone === "ok" && target.source === "rc" };
    }),
    [filtered, reachability, channelUp, capFor],
  );
  const onlineRows = rows.filter((row) => row.online);
  const offlineRows = rows.filter((row) => !row.online);
  const checkingCount = targets.filter((target) => reachability[target.node_id]?.state === "checking").length;
  const trustedCount = targets.filter((target) => target.trusted).length;

  const renderGroup = (label: string, group: RowView[]) => {
    if (group.length === 0) return null;
    const isFolded = Boolean(folded[label]);
    return (
      <div key={label}>
        <button
          type="button"
          className={styles.groupHeader}
          aria-expanded={!isFolded}
          onClick={() => setFolded((prev) => ({ ...prev, [label]: !prev[label] }))}
        >
          <ChevronRight size={12} aria-hidden="true" className={isFolded ? styles.groupChev : styles.groupChevOpen} />
          <span>{label}</span>
          <span className={styles.groupCount}>{group.length}</span>
        </button>
        {!isFolded && group.map((row) => {
          const { target, name, status, tip } = row;
          const selected = target.node_id === selectedId;
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
                {/* 标签色点堆（RustDesk TagPainter 对应物）：右上角，不占文字位 */}
                {target.tags && target.tags.length > 0 && (
                  <span className={styles.tagDots} aria-hidden="true">
                    {target.tags.map((tag) => (
                      <i key={tag.name} data-color={tagColorOf(tag)} />
                    ))}
                  </span>
                )}
                <span className={styles.deviceIcon} data-tone={status.tone}>
                  <Monitor size={16} aria-hidden="true" />
                </span>
                <span className={styles.deviceCopy}>
                  <span className={styles.deviceNameLine}>
                    <strong>{name}</strong>
                    {/* 属性图标化（RustDesk 行卡同款做法）：全称进 title，行上不排长句 */}
                    {target.denied && (
                      <span className={styles.attrBadgeDeny} title="这台设备已被禁止连接本机">
                        <ShieldAlert size={10} aria-hidden="true" />
                      </span>
                    )}
                    {target.trusted && (
                      <span className={styles.attrBadgeTrust} title="免确认已开启">
                        <ShieldCheck size={10} aria-hidden="true" />
                      </span>
                    )}
                  </span>
                  {/* 组名已表达「在线/不在线」，行上只留差异词；档位与检查时间进悬停 */}
                  <small data-tone={status.tone} title={tip || undefined}>
                    {row.shortLabel}
                  </small>
                </span>
              </button>
            </div>
          );
        })}
      </div>
    );
  };

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
          <button
            type="button"
            className={searchOpen ? styles.searchToggleOn : styles.searchToggle}
            aria-label="搜索设备"
            aria-expanded={searchOpen}
            onClick={() => {
              if (searchOpen) setQuery("");
              setSearchOpen(!searchOpen);
            }}
          >
            {searchOpen ? <X size={14} aria-hidden="true" /> : <Search size={14} aria-hidden="true" />}
          </button>
          <button type="button" className={styles.secondaryButton} onClick={onPair}>
            <Plus size={14} aria-hidden="true" />添加设备
          </button>
        </div>
        <RcA2TagFilterRow targets={targets} selected={tagFilter} onChange={setTagFilter} />
        {searchOpen && (
          <div className={styles.searchRow}>
            <input
              autoFocus
              type="search"
              placeholder="按名称筛选设备"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Escape") {
                  setQuery("");
                  setSearchOpen(false);
                }
              }}
            />
          </div>
        )}
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
        ) : targets.length === 0 ? null : rows.length === 0 ? (
          <div className={styles.sidebarEmpty}>
            <p>
              {query.trim()
                ? `没有匹配「${query.trim()}」的设备`
                : tagFilter.length
                  ? `没有带「${tagFilter.join("、")}」标签的设备`
                  : "没有符合条件的设备"}
            </p>
            <span>换个关键词，或取消标签/关闭筛选。</span>
          </div>
        ) : (
          <>
            {renderGroup("在线", onlineRows)}
            {renderGroup("不在线", offlineRows)}
          </>
        )}
      </div>
    </>
  );
}
