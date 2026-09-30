/**
 * RcSessionCapsule — 控端态会话的**唯一**浮动控制条（2026-09-24 方案 B 收编；
 * 2026-09-28 方案 A 起**窗口态与全屏态共用同一条**）。
 *
 * 收编画面四周原有 4 个 UI 中心（顶栏警示/结束、左上 HUD、右上 viewTools、
 * 底部 RcSessionBar）成一条会隐藏的深色玻璃胶囊（design/远程电脑-控端态UI-B
 * 沉浸零常驻-设计稿.html）。状态机与 ⋯ 面板开合在 useRcCapsuleReveal；分段：
 * 身份（RcCapsuleIdentity）→ 流控与视图（RcCapsuleView）→ 动作（详情 i/⋯/结束/
 * 全屏时的窗口键）。回滚链路走 useRcRemoteSend；结束/申请控制权/重连一律父级
 * confirmDialog。⚠️「版本偏旧」提示不锁显（整场常驻的条件锁了浮条就永远藏不回去）。
 *
 * 全屏态（方案 A，design/远程电脑-控端全屏胶囊统一-设计稿.html）：
 * - 同一组件、同一组浮现参数（顶缘 3px 热区 dwell 180ms / 2.5s 淡出 / 首显 15s，
 *   甲方案 2026-09-29 收紧），不再有第二条 hotbar——两态功能零分叉，画质/画面/⋯/ⓘ/
 *   质量读数在全屏里全部可达；
 * - 顶栏 `.viewTop` 全屏时整条退场（RcSessionStage 裁决），胶囊 top 归 0；
 * - 窗口三键里只留**最小化 + 关闭**（最大化在全屏无意义），关闭仍走
 *   `rc_window_close` 命令语义，不绕会话确认。
 *
 * 乙档（2026-09-29，design/远程电脑-浮条角标化-乙-设计稿.html）起的分层：
 * `.capZone`（常驻、永不 visibility:hidden）→ 微光条 + `<RcCapsuleHandle/>`（常驻出口，
 * 状态色在这）+ `.capFloat`（胶囊 + ⋯ 面板，隐藏态三重纪律挂这一层）。
 * 收起态从「零 UI」变成「剩一枚 24×12 把手」：多吃的像素换来有出口 + 异常不被卸载。
 */
import { useEffect, useId, useRef, useState } from "react";
import { ArrowDownToLine, MoreHorizontal, X } from "lucide-react";
import type { RcSession } from "@/lib/api/rc";
import type { FitMode } from "@/lib/rcSessionStats";
import type { RcKeyMode } from "@/lib/rcKeyMode";
import type { UseRc } from "@/hooks/useRc";
import type { useRcInput } from "@/hooks/useRcInput";
import type { RcLinkSnapshot } from "@/hooks/useRcLinkState";
import type { useRcRemoteSend } from "@/hooks/useRcRemoteSend";
import { useRcCapsuleReveal } from "@/hooks/useRcCapsuleReveal";
import { useRcHoverReveal } from "@/hooks/useRcHoverReveal";
import { useRcFile } from "@/hooks/useRcFile";
import { onRcDetailOpen } from "@/lib/rcDetailPanel";
import { RcCapsuleIdentity } from "./RcCapsuleIdentity";
import { RcCapsuleHandle } from "./RcCapsuleHandle";
import { RcCapsuleOutlet } from "./RcCapsuleOutlet";
import { RcCapsuleWinKeys } from "./RcCapsuleWinKeys";
import { RcCapsuleView } from "./RcCapsuleView";
import { RcCapsuleMore } from "./RcCapsuleMore";
import styles from "./RemoteComputer.module.css";

type RcInput = ReturnType<typeof useRcInput>;
type RcSend = ReturnType<typeof useRcRemoteSend>;

export function RcSessionCapsule({
  session,
  rc,
  busy,
  canControl,
  link,
  input,
  send,
  quality,
  scopePick,
  bitrate,
  rttMs = 0,
  fps = 0,
  audioOn,
  onToggleAudio,
  clipAuto,
  onToggleClipAuto,
  lastAutoAt,
  autoFail,
  onStatus,
  fit,
  onFit,
  keyMode,
  onPickKeyMode,
  fullscreen,
  onToggleFullscreen,
  onRequestEnd,
  onReconnect,
  onRequestControl,
  stageRef,
  detail,
}: {
  session: RcSession;
  rc: UseRc;
  busy: boolean;
  canControl: boolean;
  link: RcLinkSnapshot;
  input: RcInput;
  send: RcSend;
  /** 会话内生效的画质档 / 画面范围 / 码率倍率（下拉当前值）。 */
  quality: string;
  scopePick: string;
  bitrate: number;
  /** 常驻质量读数芯片的数据（与 detail/RcHud 同一份：pong EMA 与帧率）；缺省 = 无样本不显示。 */
  rttMs?: number;
  fps?: number;
  audioOn: boolean;
  onToggleAudio: () => void;
  clipAuto: boolean;
  onToggleClipAuto: () => void;
  lastAutoAt: number;
  autoFail: number;
  onStatus: (msg: string, kind: "success" | "error" | "info") => void;
  fit: FitMode;
  onFit: (m: FitMode) => void;
  /** 乙-①：键盘模式（打字 / 直传）——一级两档开关的当前值与点选。 */
  keyMode: RcKeyMode;
  onPickKeyMode: (m: RcKeyMode) => void;
  /** 会话壳全屏中（决定顶栏退场后是否补窗口键，以及全屏键的语义翻转）。 */
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  /** 父级已包 ConfirmDialog，这里只触发。 */
  onRequestEnd: () => void;
  onReconnect?: () => void;
  /** 只看态「申请控制权」（父级已包 ConfirmDialog）；未提供则不摆。 */
  onRequestControl?: () => void;
  /** 画面容器（fakeScreen）——唤出热区的坐标基准。 */
  stageRef: React.RefObject<HTMLDivElement | null>;
  /** 「连接详情」浮层（RcHud），由父级构造后传入。 */
  detail: React.ReactNode;
}) {
  const rootRef = useRef<HTMLDivElement>(null);
  const capRef = useRef<HTMLDivElement>(null);
  const floatId = useId();
  const peerDgramInput = rc.status?.peer_dgram_input;
  // ⓘ 连接详情面板开合经 rcDetailPanel 桥从 RcHud 回流（open 在 RcHud 内部），
  // 参与锁显口径——开着就别淡出（2026-09-27 审查补，与下拉/⋯面板一致）。
  const [detailOpen, setDetailOpen] = useState(false);
  useEffect(() => onRcDetailOpen(setDetailOpen), []);
  // 乙档 2026-09-29：①顶缘 hover 唤出可关（config 持久化）；把手染橙的真源是
  // 对端发来的文件请求——与 ⋯ 面板里 RcFileBar 读的是同一份 store 订阅。
  const { hoverReveal, toggleHoverReveal } = useRcHoverReveal();
  const pendingAsks = useRcFile(session.peer).asks.length;
  const { shown, thru, moreOpen, setMoreOpen, menuDelta, scheduleHide, toggle, handleState } = useRcCapsuleReveal({
    rootRef,
    capRef,
    stageRef,
    pointerLocked: input.pointerLocked,
    kbOn: input.kbOn,
    // 2026-09-27 审查修正：unansweredSec 不再参与锁显——静止画面上无害点击
    // 本就无新帧（被控端刻意不推帧），会把浮条锁在画面上几分钟不消失。
    // 🔴 乙-⑥（2026-09-29）：linkDown 同样从锁显降级成「展开一次 + 把手染红」——
    // 永久锁显等于让遮挡带 y 12–46 留到会话结束，正是甲方案要修的原点。
    linkDown: link.state !== "connected",
    detailOpen,
    hoverReveal,
    pendingCount: pendingAsks,
  });
  /** 链路死/未连通时改档控件整体禁用：send_input 是乐观写流，链路半死时
      写本地缓冲即返回 Ok——值跳了画面永远没反应且无报错（点了没反应的根源）。 */
  const sendAvailable = link.state === "connected";

  const hidden = !shown;
  const tab = hidden ? -1 : undefined;

  return (
    <div
      ref={rootRef}
      className={`${styles.capZone} ${fullscreen ? styles.capZoneFs : ""} ${thru ? styles.capZoneThru : ""}`}
      onMouseLeave={scheduleHide}
    >
      {/* 链路异常时常显微光条。🔴 乙-③：它和把手一起住在 .capZone 直下（**不在**
          会被 visibility:hidden 带走的 .capFloat 里）——收起态也必须看得见异常。 */}
      <div className={`${styles.capAlarm} ${link.state !== "connected" ? styles.capAlarmOn : ""}`} aria-hidden="true" />
      <RcCapsuleHandle state={handleState} expanded={shown} floatId={floatId} onToggle={toggle} />

      {/* 🔴 隐藏态三重纪律（.viewToolsHidden）从 .capZone 下移到这一层：规则 15.1
          要求「常驻的触发口」和它的结果同层，把手既然常驻，就不能被一起卸载。 */}
      <div id={floatId} className={`${styles.capFloat} ${hidden ? styles.viewToolsHidden : ""}`} aria-hidden={hidden}>
        <div ref={capRef} className={styles.capCapsule}>
          <RcCapsuleIdentity
            session={session}
            link={link}
            canControl={canControl}
            kbOn={input.kbOn}
            pointerLocked={input.pointerLocked}
            onReleaseCapture={(action) => (action === "pointer" ? input.togglePointerLock() : input.releaseKb())}
            peerDgramInput={peerDgramInput}
            peerInput={rc.status?.peer_input}
            peerVideoPaused={rc.status?.peer_video_paused}
            rttMs={rttMs}
            fps={fps}
            tab={tab}
            busy={busy}
            onReconnect={onReconnect}
          />

          <span className={styles.capSep} aria-hidden="true" />
          <RcCapsuleView
            rc={rc}
            send={send}
            quality={quality}
            scopePick={scopePick}
            canControl={canControl}
            sendAvailable={sendAvailable}
            fit={fit}
            onFit={onFit}
            keyMode={keyMode}
            onPickKeyMode={onPickKeyMode}
            peerInput={rc.status?.peer_input}
            fullscreen={fullscreen}
            onToggleFullscreen={onToggleFullscreen}
            tab={tab}
            menuDelta={menuDelta}
          />
          <span className={styles.capSep} aria-hidden="true" />
          {detail}
          <button
            type="button"
            tabIndex={tab}
            className={styles.capBtn}
            aria-expanded={moreOpen}
            aria-haspopup="true"
            title="更多：码率 / 声音 / 剪贴板 / 文件 / 指针 / 重连"
            onClick={() => setMoreOpen((v) => !v)}
          >
            <MoreHorizontal size={13} aria-hidden="true" />
          </button>
          {!canControl && onRequestControl && (
            <button type="button" tabIndex={tab} className={styles.capReq} disabled={busy} onClick={onRequestControl}>
              <ArrowDownToLine size={12} aria-hidden="true" />
              申请控制权
            </button>
          )}
          <button
            type="button"
            tabIndex={tab}
            /* 🔴 2026-09-27 审查：原先只有 capBtnDanger（只定义颜色）——缺 .capBtn
             基底，一直在渲染浏览器原生按钮（白底黑 X）。同排三键 P1-1 修过，
             这颗漏网。 */
            className={`${styles.capBtn} ${styles.capBtnDanger}`}
            disabled={busy}
            title="结束会话"
            aria-label="结束会话"
            onClick={onRequestEnd}
          >
            <X size={13} aria-hidden="true" />
          </button>
          {/* 全屏态顶栏退场 ⇒ 窗口键只能挂在这里（只留最小化 + 关闭，几何与
            「有会话先问」的关闭守卫见 RcCapsuleWinKeys）。 */}
          {fullscreen && <RcCapsuleWinKeys tab={tab} onStatus={onStatus} />}
        </div>

        {moreOpen && (
          <RcCapsuleMore
            rc={rc}
            canControl={canControl}
            bitrate={bitrate}
            bitrateOptions={send.bitrateOptions}
            onPickBitrate={send.pickBitrate}
            audioOn={audioOn}
            onToggleAudio={onToggleAudio}
            clipAuto={clipAuto}
            onToggleClipAuto={onToggleClipAuto}
            hoverReveal={hoverReveal}
            onToggleHoverReveal={toggleHoverReveal}
            lastAutoAt={lastAutoAt}
            autoFail={autoFail}
            onStatus={onStatus}
            pointerLocked={input.pointerLocked}
            onTogglePointer={input.togglePointerLock}
            kbOn={input.kbOn}
            onReleaseKb={input.releaseKb}
            onReconnect={onReconnect}
            busy={busy}
          />
        )}
      </div>

      {/* 甲-②（2026-09-29）：常驻结果出口条。刻意住在 `.capFloat` **之外**——
          收起态 `.capFloat` 被 visibility:hidden 带走、⋯ 面板整棵被卸载，而「失败」
          这两件事都必须还在（规则 15.1 / 15.3，全屏态里 toast 也不在这个子树）。 */}
      <RcCapsuleOutlet
        peer={session.peer}
        peerInput={rc.status?.peer_input}
        peerVideoPaused={rc.status?.peer_video_paused}
      />
    </div>
  );
}
