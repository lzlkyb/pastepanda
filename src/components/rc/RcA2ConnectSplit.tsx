/**
 * RcA2ConnectSplit — 详情面 hero 的「连接分体钮」：主按钮按发起档直连，⌄ 菜单选档直发。
 *
 * 方案 A（2026-09-26）把它从设备行搬进来：行内零按钮后，全页唯一的发起入口
 * 就是这颗大钮。菜单本体（capMenu/menuBackdrop/capMark）与定位逻辑原样沿用
 * 列表旧实现——🔴 必须 portal 到 body 的理由也原样保留在下面。
 */
import { useState } from "react";
import { createPortal } from "react-dom";
import { ChevronDown, Play } from "lucide-react";
import type { RcCapability } from "@/lib/api/rc";
import { capabilityLabel } from "@/lib/rcRequest";
import styles from "./RemoteComputerA2.module.css";

export function RcA2ConnectSplit({
  targetId,
  name,
  cap,
  denied = false,
  disabled = false,
  disabledReason = "",
  onConnect,
}: {
  targetId: string;
  name: string;
  /** 该设备的发起档（useRcLaunch.capOf）：主按钮标签与菜单 ● 同源。 */
  cap: RcCapability;
  denied?: boolean;
  disabled?: boolean;
  /** disabled 时说「为什么」（locked/未配对的原因文案，L1：说人话）。 */
  disabledReason?: string;
  onConnect: (id: string, capability: RcCapability) => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [menuPos, setMenuPos] = useState<{ top: number; right: number } | null>(null);
  // denied 语义是「挡进不挡出」：按钮写着「已禁止」，必须就地说明仍可主动连出去（旧行钮同款提示）。
  const title = disabled
    ? disabledReason
    : denied
      ? `这台设备已被你禁止远程本机；你仍可主动连接。将以「${capabilityLabel(cap)}」发起`
      : `将以「${capabilityLabel(cap)}」发起：连接${name}`;

  return (
    <>
      <span className={styles.connectGroup}>
        <button
          type="button"
          className={denied ? styles.connectButtonSec : styles.connectButton}
          aria-label={`连接${name}`}
          title={title}
          disabled={disabled}
          onClick={() => onConnect(targetId, cap)}
        >
          <Play size={14} aria-hidden="true" />
          {denied ? "已禁止" : cap === "control" ? "连接并控制" : "连接并只看"}
        </button>
        <button
          type="button"
          className={denied ? styles.connectCaretSec : styles.connectCaret}
          aria-label={`选择${name}的发起档位`}
          aria-expanded={menuOpen}
          title="选择发起档位"
          disabled={disabled}
          onClick={(e) => {
            const r = e.currentTarget.getBoundingClientRect();
            setMenuPos({ top: r.bottom + 4, right: window.innerWidth - r.right });
            setMenuOpen((open) => !open);
          }}
        >
          <ChevronDown size={10} aria-hidden="true" />
        </button>
      </span>
      {menuOpen && menuPos &&
        /* 🔴 浮层必须 portal 到 body：任何带 transform 的祖先都会成为行内
           position:fixed 的定位基准（2026-09-23 hover 浮起实测回归）。 */
        createPortal(
          <>
            {/* 透明背板：点外即收；挡住滚轮让页面不滚，fixed 菜单因此不漂移 */}
            <div className={styles.menuBackdrop} onClick={() => setMenuOpen(false)} />
            <div className={styles.capMenu} role="menu" aria-label="发起档位"
              /* ui-rule-ok: 菜单坐标是 getBoundingClientRect 在点击那一刻算出来的（menuPos），运行期值进不了 CSS Module */
              style={{ top: menuPos.top, right: menuPos.right }}>
              {([
                ["control", "可控", "对方可操作键鼠与剪贴板"],
                ["view", "只看", "仅查看画面，不能操作"],
              ] as [RcCapability, string, string][]).map(([value, label, hint]) => (
                <button key={value} type="button" role="menuitem"
                  onClick={() => {
                    setMenuOpen(false);
                    onConnect(targetId, value);
                  }}>
                  {cap === value
                    ? <em className={styles.capMark}>●</em>
                    : <em className={styles.capMarkOff}>○</em>}
                  {label}{cap === value ? "（默认）" : ""}
                  <small>{hint}</small>
                </button>
              ))}
            </div>
          </>,
          document.body,
        )}
    </>
  );
}
