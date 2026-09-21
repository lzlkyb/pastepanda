import { useMemo, useState } from "react";
import { FileUp, HandHelping, History, KeyRound, Monitor, Plus, Search, Settings, Users } from "lucide-react";
import type { RcCapability, RcTargetDevice } from "@/lib/api/rc";
import type { RcA2Page } from "@/lib/rcWorkbenchA2";
import { fingerprintOf } from "@/lib/fingerprint";
import { normalizeRcPresence, presenceMainLabel, relTime } from "@/lib/rcDevice";
import styles from "./RemoteComputerA2.module.css";

const TOOLS: { page: Exclude<RcA2Page, "devices">; label: string; icon: typeof FileUp }[] = [
  { page: "files", label: "文件", icon: FileUp },
  { page: "history", label: "记录", icon: History },
  { page: "settings", label: "设置", icon: Settings },
];

function targetName(target: RcTargetDevice): string {
  return target.note?.trim() || target.name?.trim() || fingerprintOf(target.node_id);
}

export function RcA2Sidebar({
  page,
  targets,
  selectedId,
  busy,
  locked,
  lockedLabel,
  onSelect,
  onConnect,
  onPair,
  onNavigate,
  selfEnabled,
  onToggleSelf,
  onHelpMe,
  onHelpOther,
  onUnoJoin,
}: {
  page: RcA2Page;
  targets: RcTargetDevice[];
  selectedId: string | null;
  busy: boolean;
  locked: boolean;
  lockedLabel: string;
  onSelect: (id: string) => void;
  onConnect: (id: string, capability: RcCapability) => void;
  onPair: () => void;
  onNavigate: (page: RcA2Page) => void;
  selfEnabled?: boolean;
  onToggleSelf?: (enabled: boolean) => void;
  onHelpMe?: () => void;
  onHelpOther?: () => void;
  onUnoJoin?: () => void;
}) {
  const [query, setQuery] = useState("");
  const filtered = useMemo(() => {
    const keyword = query.trim().toLocaleLowerCase();
    if (!keyword) return targets;
    return targets.filter((target) =>
      `${targetName(target)} ${target.name} ${target.node_id}`.toLocaleLowerCase().includes(keyword),
    );
  }, [query, targets]);

  return (
    <aside className={styles.sidebar} aria-label="我的设备与工具">
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
          filtered.map((target) => {
            const name = targetName(target);
            const selected = target.node_id === selectedId;
            const presence = normalizeRcPresence(target.presence);
            const unavailable = target.source !== "rc" || locked;
            return (
              <div key={target.node_id} className={`${styles.deviceItem} ${selected ? styles.deviceItemSelected : ""}`}>
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
                    <Monitor size={17} aria-hidden="true" />
                  </span>
                  <span className={styles.deviceCopy}>
                    <strong>{name}</strong>
                    <small>{presenceMainLabel(presence, relTime(target.last_seen))}</small>
                  </span>
                </button>
                <button
                  type="button"
                  className={styles.connectButton}
                  aria-label={`连接${name}`}
                  title={unavailable ? lockedLabel || "此设备当前不可连接" : `连接并控制${name}`}
                  disabled={busy || unavailable}
                  onClick={() => onConnect(target.node_id, "control")}
                >
                  连接
                </button>
              </div>
            );
          })
        )}
      </div>

      {onToggleSelf && (
        <div className={styles.receiveRow}>
          <span>
            <strong>允许别人连接本机</strong>
            <small>{selfEnabled ? "已开启，可接收远程请求" : "已暂停接收远程请求"}</small>
          </span>
          <button
            type="button"
            role="switch"
            aria-checked={selfEnabled}
            disabled={busy || locked}
            className={selfEnabled ? styles.receiveOn : styles.receiveOff}
            onClick={() => onToggleSelf(!selfEnabled)}
          >
            {selfEnabled ? "已允许" : "已暂停"}
          </button>
        </div>
      )}

      {(onHelpMe || onHelpOther || onUnoJoin) && (
        <div className={styles.assistActions} aria-label="一次性协助">
          {onHelpMe && (
            <button type="button" onClick={onHelpMe}>
              <Users size={14} aria-hidden="true" />
              让别人帮我
            </button>
          )}
          {onHelpOther && (
            <button type="button" onClick={onHelpOther}>
              <HandHelping size={14} aria-hidden="true" />
              帮助别人
            </button>
          )}
          {onUnoJoin && (
            <button type="button" className={styles.assistJoin} onClick={onUnoJoin}>
              <KeyRound size={14} aria-hidden="true" />
              输入接入码
            </button>
          )}
        </div>
      )}

      <nav className={styles.toolNav} aria-label="远程电脑工具">
        {TOOLS.map(({ page: toolPage, label, icon: Icon }) => (
          <button
            key={toolPage}
            type="button"
            className={page === toolPage ? styles.toolActive : undefined}
            aria-current={page === toolPage ? "page" : undefined}
            onClick={() => onNavigate(toolPage)}
          >
            <Icon size={15} aria-hidden="true" />
            <span>{label}</span>
          </button>
        ))}
      </nav>
    </aside>
  );
}
