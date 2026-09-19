/**
 * RcDeviceRow — 设备列表里的**一行**（从 RcDeviceList 拆出，2026-09-18）。
 *
 * 拆出来的直接原因：RcDeviceList 涨到 329 行，超了 .tsx ≤ 300 的红线；
 * 而它当时同时干两件事——遍历列表 + 画一行（含菜单/改名/四个动作）。
 *
 * 行内所有控件的语义仍照原文，两处纪律不许破：
 *  1. **行内控件一律 stopPropagation**：整行可点 = 立刻发申请，漏一个就会
 *     「点『更多』顺手多发一次申请」（设计稿风险 #1）。
 *  2. **会话进行中（locked）不许发起**：后端只有一个会话位，此时发起必被
 *     `busy_local` 拒。按钮禁用 + tooltip 说明原因，别摆一个点了必失败的入口。
 *
 * 可达性是四档（live/recent/seen/never），不是「在线/离线」：
 * 无中心服务器时组播听不见 ≠ 对端关机（见 rcDevice.presenceMainLabel）。
 *
 * 方案 A（2026-09-18）：操作区整体改成 26px 图标（见 `design/远程电脑-设备行布局-设计稿.html`）。
 * 左栏内容宽 245px，两个带文字按钮固定吃掉 140px，名称区被压到 51px / 0px；
 * 实测数字：四行合计 900px → 368px。两条配套纪律：
 *  3. **图标按钮必须 aria-label + title 成对**：省下的宽度只能靠这两处补回语义，
 *     少一个就是「一排没有名字的方块」。
 *  4. **「解除禁止」已从行内收进 ⋯ 菜单**（`allowRemote`）：三个 26px 图标在 245px 里
 *     放不下（③ 用例名称为 0），所以菜单那一项是解除禁止的**唯一**入口。
 */
import { useEffect, useRef, useState } from "react";
import { Link2, Play } from "lucide-react";
import { capabilityLabel } from "@/lib/rcRequest";
import type { RcCapability, RcTargetDevice } from "@/lib/api/rc";
import {
  deviceAvatarStyle,
  normalizeRcPresence,
  presenceHint,
} from "@/lib/rcDevice";
import { useRcDeviceActions } from "@/hooks/useRcDeviceActions";
import { RcDeviceMenu } from "./RcDeviceMenu";
import { RcDeviceMeta } from "./RcDeviceMeta";
import { RcRenameInput } from "./RcRenameInput";
import styles from "./RemoteComputer.module.css";

export function RcDeviceRow({
  d,
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
  d: RcTargetDevice;
  lastPeer: string | null;
  deviceDeny: Record<string, boolean>;
  busy: boolean;
  /** 有会话进行中（任意 phase）：发起类操作全部锁住。 */
  locked: boolean;
  lockedLabel: string;
  /** 主按钮与整行点击用哪个档发起（记住的上次档，见 `lib/rcRequest`）。 */
  requestCap: RcCapability;
  onRequest: (id: string) => void;
  onRequestWith: (id: string, cap: RcCapability) => void;
  onForget: (id: string) => Promise<boolean>;
  onSetAllowed: (id: string, allowed: boolean) => Promise<boolean>;
  onTrustToggle: (id: string, trusted: boolean) => Promise<boolean>;
  onRename: (id: string, note: string) => Promise<boolean>;
  onPair?: () => void;
  toast: (m: string, k: "success" | "error" | "info") => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const rowRef = useRef<HTMLDivElement>(null);
  const act = useRcDeviceActions({
    onForget,
    onSetAllowed,
    onTrustToggle,
    onRename,
    toast,
  });

  useEffect(() => {
    if (!menuOpen) return;
    const onDown = (e: MouseEvent) => {
      if (!rowRef.current?.contains(e.target as Node)) setMenuOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuOpen]);

  const isLast = d.node_id === lastPeer;
  const denied = deviceDeny[d.node_id] ?? d.denied;
  const trusted = d.trusted ?? false;
  const syncOnly = d.source === "sync"; // B9
  const presence = normalizeRcPresence(d.presence);
  const hint = presenceHint(presence);
  /* v5 presence 环（设计稿原则③「状态即形状」）：头像即状态——live 绿 / recent 琥珀 /
     seen·never 灰。环 + 角标点取代原来的独立小圆点（RcDeviceMeta 里的 dot 已删）。 */
  const ringCls =
    presence === "live"
      ? styles.avRingLive
      : presence === "recent"
        ? styles.avRingRecent
        : styles.avRingOff;
  const stCls =
    presence === "live"
      ? styles.avStLive
      : presence === "recent"
        ? styles.avStRecent
        : styles.avStOff;
  /** A1：显示名 = 备注（起过才用）→ 对端自报名 → 占位。 */
  const displayName = d.note?.trim() || d.name || "未命名设备";
  /** 整行点击 = 同一个主动作「发起」。纯同步设备没有可发起的动作（下一步是「去配对」）。 */
  const rowClickable = !syncOnly;
  /** 行内控件都挂它：漏一个就会「点更多 → 顺手多发一次申请」（设计稿风险 #1） */
  const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
  const requestBlocked = busy || locked;
  const requestBlockedHint = locked ? `${lockedLabel}，暂不能发起新会话` : hint;

  return (
    <div
      ref={rowRef}
      className={
        isLast
          ? `${styles.devItem} ${styles.devItemRecent}`
          : rowClickable
            ? `${styles.devItem} ${styles.devItemClickable}`
            : styles.devItem
      }
      title={locked && !syncOnly ? requestBlockedHint : undefined}
      onClick={
        rowClickable
          ? () => {
              // 菜单/编辑开着时点行 = 收起，不当成发起（否则等于点了看不见的按钮）
              if (menuOpen || editing) {
                setMenuOpen(false);
                setEditing(false);
                return;
              }
              if (!requestBlocked) onRequest(d.node_id);
            }
          : undefined
      }
    >
      {/* D1/C10：头像颜色来自公共纯函数（单色系 + 深色文字），删掉内联随机 hsl */}
      <div className={`${styles.av} ${ringCls}`} style={deviceAvatarStyle(d.node_id)}>
        {displayName.charAt(0).toUpperCase()}
        <span className={`${styles.avSt} ${stCls}`} title={hint} />
      </div>
      <div className={styles.info}>
        {editing ? (
          <RcRenameInput
            initial={d.note ?? ""}
            name={d.name || "未命名设备"}
            busy={busy}
            onSave={(v) => {
              // 🔴 只有成功才收起编辑框：失败（例如设备不在 rc 表里）时保持打开，
              //    用户输入的备注还在，不会白打一遍字。
              void act.saveRename(d.node_id, v).then(({ ok }) => {
                if (ok) setEditing(false);
              });
            }}
            onCancel={() => setEditing(false)}
          />
        ) : (
          <div className={styles.name}>
            {displayName}
            {d.note?.trim() && (
              <span className={styles.metaSub} title="本机备注 · 对端自报名保留不动">
                {" "}
                ({d.name})
              </span>
            )}
            {isLast && <span className={styles.tagRecent}>上次</span>}
            <span className={syncOnly ? styles.tagSync : styles.tagRc}>
              {syncOnly ? "同步" : "远程"}
            </span>
            {denied && <span className={styles.tagDenied}>已禁止控本机</span>}
            {/* A1：免确认的当前态要用行上的常驻徽章说清——否则「以后不再询问」只活在
                菜单里，用户翻遍界面看不出这台设备已经被放行。deny 优先于免确认，
                被禁止时不摆（那时 tagDenied 已经解释了真实状态）。 */}
            {trusted && !denied && (
              <span
                className={styles.tagTrusted}
                title="这台设备发起远程时不再弹确认条 · 可随时在菜单里恢复"
              >
                免确认
              </span>
            )}
          </div>
        )}
        <RcDeviceMeta d={d} />
      </div>
      {/* 方案 A：操作区整体图标化（26px × 2），名称区从 51px 回到 115px。
          工具提示（title）与无障碍名（aria-label）必须成对给——图标省下的宽度
          只能靠这两处补回语义。 */}
      <div className={styles.acts}>
        {/* B9：纯同步配对设备列得出却发不起 —— 不做「发起」，给下一步指引 */}
        {syncOnly ? (
          <button
            type="button"
            className={`${styles.icoBtn} ${styles.icoBig}`}
            aria-label="去配对"
            title="仅同步配对，未建立远程通道 · 去完成远程配对"
            disabled={busy || !onPair}
            onClick={(e) => {
              stop(e);
              onPair?.();
            }}
          >
            {/* 图标选型实测过：14px 下 Cable 像两根竖刺、「Link」是两个扣环，
                Link2（链环 + 横杠）在小尺寸里最认得出「配对/连接」这层意思。 */}
            <Link2 size={14} />
          </button>
        ) : (
          // 禁止的是「对方控我」，不挡「我去远程对方」
          <button
            type="button"
            className={`${styles.icoBtn} ${styles.icoPri}`}
            aria-label="发起远程"
            disabled={requestBlocked}
            // 能力记忆之后必须写明将以哪一档发起：否则「我只想看看」的人
            // 会在上次用过「可控」时被一键发起一个可控申请（设计稿风险 #3）。
            title={`发起远程 · 将以「${capabilityLabel(requestCap)}」发起 · ${requestBlockedHint}`}
            onClick={(e) => {
              stop(e);
              onRequest(d.node_id);
            }}
          >
            <Play size={13} fill="currentColor" />
          </button>
        )}
        <RcDeviceMenu
          open={menuOpen}
          onToggle={() => setMenuOpen((v) => !v)}
          syncOnly={syncOnly}
          // 会话进行中菜单项一并锁住：busy 期间点任何一项都会发一个注定失败
          // 或重复的信令（尤其「发起」类），按钮禁用了、菜单不能留成后门。
          busy={requestBlocked}
          denied={denied}
          trusted={trusted}
          onRequestWith={(cap) => {
            setMenuOpen(false);
            onRequestWith(d.node_id, cap);
          }}
          onAllowToggle={() => {
            // 方案 A：行内「解除禁止」按钮已收进菜单（三个图标在 245px 里放不下），
            // 这里是解除禁止的唯一入口。
            void act.setAllowed(d.node_id, true).then((ok) => {
              if (ok) setMenuOpen(false);
            });
          }}
          onDenyToggle={() => {
            // 只有成功才收菜单（失败时留在原地，用户看得见错误行，也不用重新开菜单）
            void act.setAllowed(d.node_id, false).then((ok) => {
              if (ok) setMenuOpen(false);
            });
          }}
          onTrustToggle={() => {
            void act.toggleTrust(d.node_id, !trusted).then((ok) => {
              if (ok) setMenuOpen(false);
            });
          }}
          onRename={() => {
            setMenuOpen(false);
            setEditing(true);
          }}
          onForget={() => {
            void act.forget(d.node_id, displayName).then((ok) => {
              if (ok) setMenuOpen(false);
            });
          }}
        />
      </div>
    </div>
  );
}
