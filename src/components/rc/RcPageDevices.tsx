/**
 * RcPageDevices — 「设备列表」页（v4 布局，2026-09-19）。
 *
 * 与主页左栏的区别**只在浏览方式**：全量行 + 搜索 + 可达性筛选。行渲染、菜单、
 * 改名、四档可达性全部复用 `RcDeviceList` / `RcDeviceRow`——不复制行逻辑
 * （MEMORY-rc「文件归属」表：行内交互纪律都在 RcDeviceRow，别在这里再整一份）。
 *
 * 筛选是纯前端过滤：`presence` 四档来自 `lib/rcDevice`（live/recent/seen/never），
 * 「在线」= live 一档；「已禁止」= denied。搜索匹配备注名 / 原名 / node_id 前缀。
 */
import { useMemo, useState } from "react";
import { Radar, Search, UserPlus } from "lucide-react";
import type { RcCapability } from "@/lib/api/rc";
import { rcDeviceRename } from "@/lib/api/rc";
import type { UseRc } from "@/hooks/useRc";
import type { useToast } from "@/components/Toast";
import { RcDeviceList } from "./RcDeviceList";
import styles from "./RemoteComputer.module.css";

type Filter = "all" | "online" | "denied";

export function RcPageDevices({
  rc,
  toast,
  cap,
  lastPeer,
  locked,
  lockedLabel,
  onPair,
  onStartChannel,
  onForget,
  onRequest,
  onRequestWith,
  onSendFiles,
}: {
  rc: UseRc;
  toast: ReturnType<typeof useToast>["toast"];
  cap: RcCapability;
  lastPeer: string | null;
  locked: boolean;
  lockedLabel: string;
  onPair: () => void;
  onStartChannel: () => void;
  onForget: (id: string) => Promise<boolean>;
  onRequest: (id: string) => void;
  onRequestWith: (id: string, c: RcCapability) => void;
  /** G6：设备行菜单「传文件」→ 切到文件传输页并预选这台设备。 */
  onSendFiles?: (id: string) => void;
}) {
  const [q, setQ] = useState("");
  const [filter, setFilter] = useState<Filter>("all");
  const channelUp = rc.status?.running ?? false;

  const counts = useMemo(
    () => ({
      all: rc.targets.length,
      online: rc.targets.filter((t) => t.presence === "live").length,
      denied: rc.targets.filter((t) => t.denied).length,
    }),
    [rc.targets],
  );

  const filtered = useMemo(() => {
    const kw = q.trim().toLowerCase();
    return rc.targets.filter((t) => {
      if (filter === "online" && t.presence !== "live") return false;
      if (filter === "denied" && !t.denied) return false;
      if (!kw) return true;
      return (
        (t.note ?? "").toLowerCase().includes(kw) ||
        t.name.toLowerCase().includes(kw) ||
        t.node_id.toLowerCase().startsWith(kw)
      );
    });
  }, [rc.targets, q, filter]);

  return (
    <div className={styles.pageWrap} role="region" aria-label="设备列表">
      <div className={styles.searchRow}>
        <span className={styles.searchBox}>
          <Search size={14} aria-hidden="true" />
          <input
            type="search"
            className={styles.searchInput}
            placeholder="搜索设备名或指纹前缀"
            aria-label="搜索设备"
            value={q}
            onChange={(e) => setQ(e.target.value)}
          />
        </span>
        {/* v4 对稿（第三轮，C 窗）：搜索行 = 搜索左 / 筛选右；「检测在线 / 配对设备」
            上提顶栏（RcTopBar actions），不再挤在这一行。 */}
        <span className={styles.tbSp} />
        <div className={styles.filterRow} role="group" aria-label="按可达性筛选">
          {(
            [
              ["all", "全部"],
              ["online", "在线"],
              ["denied", "已禁止"],
            ] as [Filter, string][]
          ).map(([key, label]) => (
            <button
              key={key}
              type="button"
              className={`${styles.fPill} ${filter === key ? styles.fPillOn : ""}`}
              aria-pressed={filter === key}
              onClick={() => setFilter(key)}
            >
              {label} {counts[key]}
            </button>
          ))}
        </div>
      </div>

      {locked && <div className={styles.lockNote}>{lockedLabel} · 设备操作暂时锁定</div>}

      {rc.targets.length === 0 ? (
        <div className={styles.histNote}>
          还没有配对设备。完成一次远程配对后，设备会出现在这里。
        </div>
      ) : !channelUp ? (
        <div className={styles.noteWarn}>
          已配对 {rc.targets.length} 台，但远程通道未启动。
          <div className={styles.mt10}>
            <button
              type="button"
              className={styles.miniBtnPri}
              disabled={rc.busy}
              onClick={onStartChannel}
            >
              开启远程通道
            </button>
          </div>
        </div>
      ) : filtered.length === 0 ? (
        <div className={styles.histNote}>没有匹配「{q || labelOf(filter)}」的设备。</div>
      ) : (
        <>
          {/* v4 对稿（C 窗）：列表表头。纯展示（aria-hidden）——行语义全在
              RcDeviceRow 的行内按钮与可达性点上，表头不参与朗读。 */}
          <div className={styles.listHead} aria-hidden="true">
            <span className={styles.listHeadAv} />
            <span>设备</span>
            <span className={styles.tbSp} />
            <span className={styles.listHeadOp}>操作</span>
          </div>
          <RcDeviceList
            targets={filtered}
            lastPeer={lastPeer}
            deviceDeny={rc.status?.device_deny ?? {}}
            busy={rc.busy}
            locked={locked}
            lockedLabel={lockedLabel}
            requestCap={cap}
            onRequest={onRequest}
            onRequestWith={onRequestWith}
            onSendFiles={onSendFiles}
            onForget={onForget}
            onSetAllowed={async (id, allowed) => rc.setDeviceAllowed(id, allowed)}
            onTrustToggle={async (id, trusted) => rc.setDeviceTrust(id, trusted)}
            onAutoAcceptToggle={async (id, on) => rc.setDeviceAutoAccept(id, on)}
            onRename={async (id, note) => {
              try {
                await rcDeviceRename(id, note);
                await rc.refreshTargets();
                return true;
              } catch (e) {
                toast(String(e), "error");
                return false;
              }
            }}
            onPair={onPair}
            toast={toast}
          />
        </>
      )}
    </div>
  );
}

function labelOf(f: Filter): string {
  return f === "all" ? "全部" : f === "online" ? "在线" : "已禁止";
}

/**
 * RcDevicesTopActions — 设备列表页**顶栏**右侧的动作（v5 设计稿 C 窗）：
 * 检测在线（文字链）+ 配对设备（主按钮）。由 RcWorkbench 塞进 RcTopBar 的
 * actions 插槽；语义与第三轮上提时一致，这里只是把 JSX 从 RcWorkbench 挪过来，
 * 让调用方保持在 .tsx ≤ 300 红线内。
 */
export function RcDevicesTopActions({
  probing,
  onProbe,
  onPair,
}: {
  probing: boolean;
  onProbe: () => void;
  onPair: () => void;
}) {
  return (
    <>
      <button
        type="button"
        className={styles.linkBtn}
        disabled={probing}
        title="对非「在线」设备短超时探测一次（打开工作台时也会自动探）"
        onClick={onProbe}
      >
        <Radar size={12} aria-hidden="true" />
        {probing ? "检测中…" : "检测在线"}
      </button>
      <button type="button" className={styles.miniBtnPri} onClick={onPair}>
        <UserPlus size={13} aria-hidden="true" />
        配对设备
      </button>
    </>
  );
}
