/**
 * RcSessionCapsule — 控端态会话的**唯一**浮动控制条（2026-09-24 控端态 UI 方案 B 收编）。
 *
 * 收编画面四周原有 4 个 UI 中心（顶栏警示/结束、左上 HUD、右上 viewTools、
 * 底部 RcSessionBar）成一条会隐藏的深色玻璃胶囊（design/远程电脑-控端态UI-B
 * 沉浸零常驻-设计稿.html）。状态机与 ⋯ 面板开合在 useRcCapsuleReveal；分段：
 * 身份（灯/名字/能力/键盘态/警示）→ 画质 → 视图 → 动作（详情 i/⋯/结束）。
 * 回滚链路走 useRcRemoteSend；结束/申请控制权/重连一律父级 confirmDialog。
 * ⚠️「版本偏旧」提示不锁显（整场常驻的条件锁了浮条就永远藏不回去）。
 * 挂载：RcSessionView（非全屏才挂；全屏态由 RcFullscreenHotbar 承担，互斥）。
 */
import { useEffect, useRef, useState } from "react";
import { ArrowDownToLine, Maximize2, MoreHorizontal, X } from "lucide-react";
import { fingerprintOf } from "@/lib/fingerprint";
import { rcDisplayName } from "@/lib/rcDevice";
import type { RcSession, RcQuality, RcCaptureScope } from "@/lib/api/rc";
import type { FitMode } from "@/lib/rcSessionStats";
import type { UseRc } from "@/hooks/useRc";
import type { useRcInput } from "@/hooks/useRcInput";
import type { RcLinkSnapshot } from "@/hooks/useRcLinkState";
import type { useRcRemoteSend } from "@/hooks/useRcRemoteSend";
import { useRcCapsuleReveal } from "@/hooks/useRcCapsuleReveal";
import { onRcDetailOpen } from "@/lib/rcDetailPanel";
import { RcDropdown } from "./RcDropdown";
import { RcCapsuleMore } from "./RcCapsuleMore";
import { RcCapsuleAlerts } from "./RcCapsuleAlerts";
import { RcQualityChip } from "./RcQualityChip";
import styles from "./RemoteComputer.module.css";

type RcInput = ReturnType<typeof useRcInput>;
type RcSend = ReturnType<typeof useRcRemoteSend>;

const FITS: Array<[FitMode, string]> = [
  ["fit", "适应"],
  ["actual", "1:1"],
  ["fill", "填充"],
];
const FIT_TIPS: Record<FitMode, string> = {
  fit: "缩放画面适配窗口",
  actual: "按原始像素显示（1:1，可拖动平移）",
  fill: "填满窗口（可能裁切边缘）",
};

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
  const peerDgramInput = rc.status?.peer_dgram_input;
  // ⓘ 连接详情面板开合经 rcDetailPanel 桥从 RcHud 回流（open 在 RcHud 内部），
  // 参与锁显口径——开着就别淡出（2026-09-27 审查补，与下拉/⋯面板一致）。
  const [detailOpen, setDetailOpen] = useState(false);
  useEffect(() => onRcDetailOpen(setDetailOpen), []);
  const { shown, moreOpen, setMoreOpen, menuDelta, scheduleHide } = useRcCapsuleReveal({
    rootRef,
    capRef,
    stageRef,
    pointerLocked: input.pointerLocked,
    // 2026-09-27 审查修正：unansweredSec 不再参与锁显——静止画面上无害点击
    // 本就无新帧（被控端刻意不推帧），会把浮条锁在画面上几分钟不消失。
    // 琥珀警示胶囊仍在，锁显只跟链路死活走。
    linkLocked: link.state !== "connected",
    detailOpen,
  });
  /** 链路死/未连通时改档控件整体禁用：send_input 是乐观写流，链路半死时
      写本地缓冲即返回 Ok——值跳了画面永远没反应且无报错（点了没反应的根源）。 */
  const sendAvailable = link.state === "connected";

  const hidden = !shown;
  const tab = hidden ? -1 : undefined;
  const dotCls =
    link.state === "connected"
      ? styles.live
      : link.state === "failed"
        ? styles.liveBad
        : styles.liveOff;

  return (
    <div
      ref={rootRef}
      className={`${styles.capZone} ${hidden ? styles.viewToolsHidden : ""}`}
      aria-hidden={hidden}
      onMouseLeave={scheduleHide}
    >
      {/* 链路异常时的常显微光条：热区从「隐形」变「可见」，异常永远有两个可见信号 */}
      <div
        className={`${styles.capAlarm} ${link.state !== "connected" ? styles.capAlarmOn : ""}`}
        aria-hidden="true"
      />
      <div ref={capRef} className={styles.capCapsule}>
        <span className={dotCls} />
        <span className={styles.capWho}>{rcDisplayName(session, fingerprintOf(session.peer))}</span>
        {/* 2026-09-26 对齐稿：常驻质量读数贴着身份段（AnyDesk 顶栏同款位）；
            无样本整枚不渲染，链路死活仍归 capAlarm/顶条红灯。 */}
        <RcQualityChip rttMs={rttMs} fps={fps} tab={tab} />
        <span className={canControl ? styles.capPillOn : styles.capPillView}>
          {canControl ? "可控" : "只看"}
        </span>
        {/* 键盘态：原底栏灰字「点画面可捕获键盘」升级上浮条（最重要的上手提示） */}
        {canControl &&
          (input.kbOn ? (
            <span className={styles.capKb}>
              <i aria-hidden="true" />
              键盘已捕获
            </span>
          ) : (
            <span className={styles.capKbOff}>点画面可捕获键盘</span>
          ))}
        {canControl && peerDgramInput === false && (
          <span
            className={styles.capPillWarn}
            title="远程鼠标移动走数据报通道，官方 7.2.1 及更早的被控端收不到。请对方升级 PastePanda 到最新版后重新连接；按键/点击仍可尝试。"
          >
            对方版本偏旧
          </span>
        )}
        <RcCapsuleAlerts link={link} tab={tab} busy={busy} onReconnect={onReconnect} />

        <span className={styles.capSep} aria-hidden="true" />
        {/* D-2：只看仍可调画质/编码（流控）；画面范围要求可控（改主机采集范围） */}
        <RcDropdown
          label="画质"
          value={quality as RcQuality}
          options={send.qualities}
          columns={2}
          disabled={rc.busy || !sendAvailable}
          disabledTitle={
            sendAvailable ? undefined : "链路未连通，暂不能改画质；连通后可再调"
          }
          onPick={send.pickQuality}
          onOpenChange={menuDelta}
        />
        {canControl && (
          <>
            <span className={styles.capSep} aria-hidden="true" />
            <RcDropdown
              label="画面"
              value={scopePick as RcCaptureScope}
              options={send.scopes}
              disabled={rc.busy || !canControl || !sendAvailable}
              disabledTitle={
                sendAvailable ? undefined : "链路未连通，暂不能改画面范围；连通后可再调"
              }
              onPick={send.pickScope}
              onOpenChange={menuDelta}
            />
            {/* Q7：对端有 ≥2 块屏才出「下一屏」，多屏高频轮换不开下拉 */}
            {send.canCycleScreen && (
              <button
                type="button"
                tabIndex={tab}
                className={styles.capBtn}
                disabled={rc.busy || !sendAvailable}
                title={
                  sendAvailable
                    ? "切换到对方的下一块显示器（循环）"
                    : "链路未连通，暂不能切屏"
                }
                onClick={send.cycleScreen}
              >
                下一屏
              </button>
            )}
          </>
        )}
        <span className={styles.capSep} aria-hidden="true" />
        {/* 🔴 三键**必须**挂 .capBtn（2026-09-27 P1-1）：
            未选中档曾经写成 `undefined` ⇒ 一条规则都不匹配，而全库没有
            button 重置（globals.css 只有 `*{margin:0;padding:0}`）⇒ 三键退回
            浏览器原生外观（2px outset / 圆角 0 / 浅灰底 / Arial 13.33px），
            与同排的全屏 / 详情 / ⋯ 键完全不是一族。
            tsc / eslint / lint:ui / lint:css 四个工具对此全是绿的
            （className 有值、CSS 类存在，只是没接上），
            只有渲染断言能拦住 —— 见 RcSessionCapsule.test.tsx 的「FIT 三键」用例。 */}
        <span className={styles.capFit}>
          {FITS.map(([k, label]) => (
            <button
              key={k}
              type="button"
              tabIndex={tab}
              className={fit === k ? `${styles.capBtn} ${styles.capBtnOn}` : styles.capBtn}
              title={FIT_TIPS[k]}
              onClick={() => onFit(k)}
            >
              {label}
            </button>
          ))}
        </span>
        <button
          type="button"
          tabIndex={tab}
          className={styles.capBtn}
          title="全屏显示远程画面（F11）"
          onClick={onToggleFullscreen}
        >
          <Maximize2 size={13} aria-hidden="true" />
        </button>
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
  );
}
