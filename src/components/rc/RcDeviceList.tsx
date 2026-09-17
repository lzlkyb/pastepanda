/**
 * RcDeviceList — 设备卡片：可达性档位 / 发起 / 禁止 / 忘记 / 菜单。
 *
 * 🔴 不再用二值「在线/离线」：无中心服务器时组播听不见 ≠ 对端关机。
 * 四档文案见 `rcDevice.presenceMainLabel` 与 design/远程设备多档在线状态-设计稿.html。
 *
 * B（2026-09-17，见 design/远程电脑-交互精简-B方案-设计稿.html §1/§2）：
 * - 主按钮「远程」→「发起」，点击**直接发申请**（不再弹「选能力 → 发送」两步卡）；
 * - 能力档来自上次（`lib/rcRequest`），tooltip 必须写明「将以『只看』发起」；
 * - 需要显式换档时才走 ⋯ 菜单（原申请卡的职能收进菜单）；
 * - 整行也可点 = 同一个主动作；**行内所有控件必须 stopPropagation**，
 *   否则点「更多」会顺手多发一次申请（设计稿风险 #1）。
 */
import { useEffect, useRef, useState } from "react";
import { MoreHorizontal } from "lucide-react";
import { fingerprintOf } from "@/lib/fingerprint";
import { confirmDialog } from "@/lib/confirm";
import { pathKindLabel } from "@/lib/rcSessionStats";
import { capabilityLabel } from "@/lib/rcRequest";
import type { RcCapability, RcTargetDevice } from "@/lib/api/rc";
import {
  deviceAvatarStyle,
  lastSeenHint,
  relTime,
  presenceMainLabel,
  presenceHint,
  presenceDotClass,
  type RcPresenceLevel,
} from "@/lib/rcDevice";
import styles from "./RemoteComputer.module.css";

function normalizePresence(raw: string | undefined): RcPresenceLevel {
  if (raw === "live" || raw === "recent" || raw === "seen" || raw === "never") {
    return raw;
  }
  // 旧字段兜底：后端未带 presence 时按「见过」处理，不假装在线
  return "seen";
}

export function RcDeviceList({
  targets,
  lastPeer,
  deviceDeny,
  busy,
  requestCap,
  onRequest,
  onRequestWith,
  onForget,
  onSetAllowed,
  onPair,
  toast,
}: {
  targets: RcTargetDevice[];
  lastPeer: string | null;
  deviceDeny: Record<string, boolean>;
  busy: boolean;
  /** 主按钮与整行点击用哪个档发起（记住的上次档，见 `lib/rcRequest`）。tooltip 会写明它。 */
  requestCap: RcCapability;
  onRequest: (id: string) => void;
  /** ⋯ 菜单里显式指定档发起——原「申请卡」的选档职能，改成按需展开。 */
  onRequestWith: (id: string, cap: RcCapability) => void;
  onForget: (id: string) => Promise<boolean>;
  onSetAllowed: (id: string, allowed: boolean) => Promise<boolean>;
  /** B9：纯同步配对设备「列得出却发不起」，给一个去完成远程配对的入口。 */
  onPair?: () => void;
  toast: (m: string, k: "success" | "error" | "info") => void;
}) {
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!menuFor) return;
    const onDown = (e: MouseEvent) => {
      if (!listRef.current?.contains(e.target as Node)) setMenuFor(null);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setMenuFor(null);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [menuFor]);

  const forget = async (id: string, name: string) => {
    const ok = await confirmDialog({
      title: "忘记此设备",
      message: `将从远程配对列表移除「${name}」。之后需要重新配对才能远程。`,
      confirmText: "忘记",
      variant: "danger",
    });
    if (!ok) return;
    if (await onForget(id)) {
      toast("已忘记该设备", "success");
      setMenuFor(null);
    }
  };

  // C9：函数名为「deny」却在「允许」——改名 setAllowed，与行为一致。
  const setAllowed = async (id: string, currentlyDenied: boolean) => {
    if (await onSetAllowed(id, !currentlyDenied)) {
      toast(
        currentlyDenied ? "已允许该设备远程本机" : "已禁止该设备远程本机",
        "success",
      );
      setMenuFor(null);
    }
  };

  return (
    <div className={styles.devList} ref={listRef}>
      {targets.map((d) => {
        const presence = normalizePresence(d.presence);
        const isLast = d.node_id === lastPeer;
        const denied = deviceDeny[d.node_id] ?? d.denied;
        const lastSeen = relTime(d.last_seen); // D4
        const syncOnly = d.source === "sync"; // B9
        const mainLabel = presenceMainLabel(presence, lastSeen);
        const hint = presenceHint(presence);
        const dotKey = presenceDotClass(presence);
        const dotCls =
          dotKey === "dotOn"
            ? styles.dotOn
            : dotKey === "dotRecent"
              ? styles.dotRecent
              : styles.dotOff;
        // 尾部「上次 …」合并成一段：时间与实走的路径（B-5）不再各占一个「上次」。
        // 两者都取不到 → 空串 ⇒ 整段不渲染（不编默认值）。
        const tailHint = lastSeenHint(
          lastSeen,
          presence !== "recent" && presence !== "live",
          pathKindLabel(d.last_path ?? ""),
        );
        // 整行点击 = 同一个主动作「发起」。纯同步设备没有可发起的动作
        // （它的下一步是「去配对」），整行点击刻意不做。
        const rowClickable = !syncOnly;
        // 行内控件都挂它：漏一个就会「点更多 → 顺手多发一次申请」（设计稿风险 #1）
        const stop = (e: { stopPropagation: () => void }) => e.stopPropagation();
        return (
          <div
            key={d.node_id}
            className={
              isLast
                ? `${styles.devItem} ${styles.devItemRecent}`
                : rowClickable
                  ? `${styles.devItem} ${styles.devItemClickable}`
                  : styles.devItem
            }
            onClick={
              rowClickable
                ? () => {
                    // 菜单开着时点行 = 收菜单，不当成发起（否则等于点了看不见的按钮）
                    if (menuFor === d.node_id) {
                      setMenuFor(null);
                      return;
                    }
                    if (!busy) onRequest(d.node_id);
                  }
                : undefined
            }
          >
            {/* D1/C10：头像颜色来自公共纯函数（单色系 + 深色文字），删掉内联随机 hsl */}
            <div className={styles.av} style={deviceAvatarStyle(d.node_id)}>
              {(d.name || "?").charAt(0).toUpperCase()}
            </div>
            <div className={styles.info}>
              <div className={styles.name}>
                {d.name || "未命名设备"}
                {isLast && <span className={styles.tagRecent}>上次</span>}
                <span className={syncOnly ? styles.tagSync : styles.tagRc}>
                  {syncOnly ? "同步" : "远程"}
                </span>
                {denied && <span className={styles.tagDenied}>已禁止控本机</span>}
              </div>
              <div className={styles.meta}>
                <span className={dotCls} />
                {mainLabel} · {fingerprintOf(d.node_id)} · {hint}
                {tailHint && (
                  <span
                    className={styles.metaSub}
                    title="上次会话实测的信息（路径是实测值，不是推断）"
                  >
                    {" "}
                    · {tailHint}
                  </span>
                )}
                {syncOnly && " · 仅同步配对，未建立远程通道"}
              </div>
            </div>
            {denied && (
              <button
                type="button"
                className={styles.miniBtn}
                disabled={busy}
                title="解除后对方才能申请远程本机"
                onClick={(e) => {
                  stop(e);
                  void setAllowed(d.node_id, true);
                }}
              >
                解除禁止
              </button>
            )}
            {/* B9：纯同步配对设备列得出却发不起 —— 不做「远程」按钮，给下一步指引 */}
            {syncOnly ? (
              <button
                type="button"
                className={styles.miniBtn}
                disabled={busy || !onPair}
                title="仅同步配对，未建立远程通道 · 去完成远程配对"
                onClick={(e) => {
                  stop(e);
                  onPair?.();
                }}
              >
                去配对
              </button>
            ) : (
              // 禁止的是「对方控我」，不挡「我去远程对方」
              <button
                type="button"
                className={`${styles.miniBtnPri} ${styles.wideBtn}`}
                disabled={busy}
                // 能力记忆之后必须写明将以哪一档发起：否则「我只想看看」的人
                // 会在上次用过「可控」时被一键发起一个可控申请（设计稿风险 #3）。
                title={`将以「${capabilityLabel(requestCap)}」发起 · ${hint}`}
                onClick={(e) => {
                  stop(e);
                  onRequest(d.node_id);
                }}
              >
                发起
              </button>
            )}
            <div className={styles.devMenuWrap}>
              {/* D5/L2：图标旁补常驻文字标签「更多」 */}
              <button
                type="button"
                className={styles.miniBtn}
                aria-label="更多操作"
                onClick={(e) => {
                  stop(e);
                  setMenuFor(menuFor === d.node_id ? null : d.node_id);
                }}
              >
                <MoreHorizontal size={14} />
                更多
              </button>
              {menuFor === d.node_id && (
                /* 菜单整体吃掉冒泡：菜单项在整行内部，不拦就会连行点击一起触发
                   ⇒ 点「以『可控』发起」等于发两次申请。挂在容器上一次，
                   以后往菜单里加项也不会漏（设计稿风险 #1）。 */
                <div className={styles.devMenu} onClick={stop}>
                  {/* 原「申请卡」的选档职能收进菜单：只在需要显式换档时才展开，常态不占屏 */}
                  {!syncOnly && (
                    <>
                      <div className={styles.mDim}>以指定方式发起</div>
                      <button
                        type="button"
                        className={styles.mSafe}
                        disabled={busy}
                        onClick={() => {
                          setMenuFor(null);
                          onRequestWith(d.node_id, "view");
                        }}
                      >
                        以「只看」发起
                      </button>
                      <button
                        type="button"
                        className={styles.mSafe}
                        disabled={busy}
                        onClick={() => {
                          setMenuFor(null);
                          onRequestWith(d.node_id, "control");
                        }}
                      >
                        以「可控」发起
                      </button>
                      <div className={styles.mSep} />
                    </>
                  )}
                  {!denied && !syncOnly && (
                    <button type="button" onClick={() => void setAllowed(d.node_id, false)}>
                      禁止远程本机
                    </button>
                  )}
                  <button
                    type="button"
                    onClick={() => void forget(d.node_id, d.name || "该设备")}
                  >
                    忘记设备
                  </button>
                </div>
              )}
            </div>
          </div>
        );
      })}
    </div>
  );
}