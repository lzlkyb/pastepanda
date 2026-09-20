/**
 * RcControlBanner — 被控中常驻横幅：谁 + 能力 + 时长 + 结束（规则 15）。
 *
 * B3：横幅还要负责「对方改了画面范围」的可见提示。观察者（包括只看会话）
 * 能改被观察者的采集范围，原来是静默的——用户不知道自己的画面被切到别处。
 * Q10：同理负责「对方改了画质/编码」的提示，一直是静默 log。
 * 提示一直留到用户点「知道了」或会话结束（store 在会话切换/结束时清）。
 */
import { useEffect, useState } from "react";
import { Volume2, VolumeX } from "lucide-react";
import { fingerprintOf } from "@/lib/fingerprint";
import { formatDuration } from "@/lib/rcSessionStats";
import { scopeLabelLong } from "@/lib/rcScope";
import { qualityLabel } from "@/lib/rcQuality";
import { useRcFile } from "@/hooks/useRcFile";
import { confirmDialog } from "@/lib/confirm";
import type { RcSession } from "@/lib/api/rc";
import { RcFileAskLine } from "./RcFileAsk";
import styles from "./RemoteComputer.module.css";

export function RcControlBanner({
  session,
  busy,
  trusted,
  onTrust,
  onEnd,
  scopeNotice,
  onDismissScopeNotice,
  streamNotice,
  onDismissStreamNotice,
  audioLocalMute,
  onToggleAudioLocalMute,
  spkMutedByPeer,
  onRestoreSpk,
}: {
  session: RcSession;
  busy: boolean;
  /** 方案 D：该对端是否已开免确认（发起时跳过本机确认条）。 */
  trusted?: boolean;
  /**
   * A2：就地开启免确认——「以后不再询问这台设备」。
   *
   * 时机比入口重要：用户此刻正被这台设备控制着，对「要不要长期放行它」最有判断力。
   * 不传 = 不显示（例如该设备已被禁止远程本机，deny 优先级高于免确认）。
   */
  onTrust?: () => void;
  onEnd: () => void;
  /** 对端刚改成的画面范围；null 表示没有待展示的变更 */
  scopeNotice?: string | null;
  onDismissScopeNotice?: () => void;
  /** Q10：对端刚改的推流档位（quality / codec）；null 表示没有待展示的变更 */
  streamNotice?: { kind: string; name: string } | null;
  onDismissStreamNotice?: () => void;
  /** G3：本机是否已静音系统声音（一票否决——对端开着也听不到）。 */
  audioLocalMute?: boolean;
  /**
   * G3：切换本机静音。不传 = 不显示按钮（例如非 Windows 被控端，音频链路不存在）。
   */
  onToggleAudioLocalMute?: () => void;
  /**
   * G3-C：对端静音了本机扬声器（物理外放被远程关掉）。不传/否 = 不摆提示。
   */
  spkMutedByPeer?: boolean;
  /** G3-C：本机一键恢复外放。不传 = 只提示不给入口（不摆半条路）。 */
  onRestoreSpk?: () => void;
}) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = window.setInterval(() => setNow(Date.now()), 1000);
    return () => window.clearInterval(t);
  }, [session.id]);

  // G6：文件请求可能**在没有会话时**到达（文件通道独立于会话），那种情况走
  // RcOverlay 的常驻分支。有会话时在这条横幅里出——人不在工作台也看得见（规则 15）。
  const file = useRcFile(session.peer);

  return (
    <div className={styles.ctrlBanner}>
      {/* C5：live region 只包「状态变化」（被控中），不包每秒刷新的计时器 */}
      <div role="status" aria-live="polite">
        <span className={styles.who}>
          <span className={styles.dotDanger} />
          正在被「{session.peer_name || fingerprintOf(session.peer)}」远程
        </span>
        <span className={styles.pillDanger}>
          {session.capability === "control" ? "可控" : "只看"}
        </span>
      </div>
      {/* 计时器：纯视觉、每秒变，移出 live region，避免屏幕阅读器每秒播报 */}
      <span className={styles.timer} aria-hidden="true">
        {formatDuration(now - session.started_ms)}
      </span>
      {/* B3：只在真的发生变更时出现，属于一次性状态变化，放 live region 里播一次是对的 */}
      {scopeNotice && (
        <span className={styles.scopeNotice} role="status" aria-live="polite">
          对方把画面范围改成了「{scopeLabelLong(scopeNotice)}」
          <button
            type="button"
            className={styles.scopeNoticeX}
            onClick={onDismissScopeNotice}
          >
            知道了
          </button>
        </span>
      )}
      {/* Q10：画质/编码被对端改动同上——一次性状态变化，播一次。
          G3：系统声音同理——「我的声音正在被对方听」不比画面被切走次要。 */}
      {streamNotice && (
        <span className={styles.scopeNotice} role="status" aria-live="polite">
          {streamNotice.kind === "audio"
            ? streamNotice.name === "off"
              ? "对方已停止接收本机系统声音"
              : // ❗ 本机已静音时这句不能照说：「对方开始接收」是事实，但
                // 「对方能听到」是假话（本机静音一票否决）。宁啰嗦不骗人。
                audioLocalMute
                ? "对方开启了系统声音接收，但你已在本机静音——对方仍听不到"
                : "对方开始接收本机系统声音（你现在播放的声音对方能听到）"
            : streamNotice.kind === "codec"
              ? `对方把编码切成了「${streamNotice.name === "h264" ? "H.264" : streamNotice.name === "hevc" ? "HEVC" : "JPEG"}」`
              : `对方把画质调成了「${qualityLabel(streamNotice.name)}」`}
          <button
            type="button"
            className={styles.scopeNoticeX}
            onClick={onDismissStreamNotice}
          >
            知道了
          </button>
        </span>
      )}
      {/* G6：文件请求确认条（一行版）。与「对方改了画质」同一位置、同一优先级——
          「有东西要写进我的磁盘」至少和「我的画面被改了」一样需要立刻被看见。
          60s 不回应 = 拒绝，倒计时在组件里；点接受会弹系统目录/文件选择框
          （模态，不受主窗口焦点影响）。 */}
      {/* B6：同 RcInboundView——全部待响应请求都摆出来，别只摆第一条 */}
      {file.asks.map((a) => (
        <RcFileAskLine key={a.id} ask={a} busy={busy} onRespond={file.respond} />
      ))}
      {/* G3-C：对端把**本机扬声器**远程静音了。必须说出来——物理外放突然没了，
          用户第一反应是「电脑/声卡坏了」。恢复入口就摆在旁边（本机一键恢复，
          并顺手告诉对端，免得它那边的按钮停在旧状态）。 */}
      {spkMutedByPeer && (
        <span className={styles.scopeNotice} role="status" aria-live="polite">
          对方静音了本机扬声器外放
          {onRestoreSpk && (
            <button type="button" className={styles.scopeNoticeX} disabled={busy} onClick={onRestoreSpk}>
              恢复外放
            </button>
          )}
        </span>
      )}
      <span className={styles.sp} />
      {/* G3：被控者本机静音。放在「以后不再询问」之前——两者都是本人对此刻的即时
          决定，且要和右侧「立即结束」（误触代价不对称）拉开距离。
          它是一票否决：对端开得再欢也听不到；跨会话保持，不开新会话就一直是关的。 */}
      {onToggleAudioLocalMute && (
        <button
          type="button"
          className={
            audioLocalMute
              ? `${styles.audioMuteBtn} ${styles.audioMuteBtnOn}`
              : styles.audioMuteBtn
          }
          aria-pressed={audioLocalMute ? true : false}
          title={
            audioLocalMute
              ? "本机系统声音现在不会被对方听到（一票否决，对端自己开着也没用）。点此恢复发送。"
              : "对方将听不到本机播放的系统声音（不影响影音之外的画面与控制）。关了就跨会话保持，直到你点回来。"
          }
          onClick={onToggleAudioLocalMute}
        >
          {audioLocalMute ? (
            <VolumeX size={12} aria-hidden="true" />
          ) : (
            <Volume2 size={12} aria-hidden="true" />
          )}
          {audioLocalMute ? "恢复发送声音" : "不发送声音"}
        </button>
      )}
      {/* A2：这里开的是一次性会话里的「长期放行」，文案必须说清边界——
          它是「不再逐次询问」，不是「无人值守」，会话横幅照常常驻、随时可结束。 */}
      {trusted ? (
        <span
          className={styles.trustOn}
          title="这台设备下次发起远程会直接连入；可在设备菜单里恢复逐次询问"
        >
          已免确认
        </span>
      ) : (
        onTrust && (
          <button
            type="button"
            className={styles.miniBtn}
            disabled={busy}
            title="这台设备以后发起远程时直接连入，不再弹这条确认；可随时在设备菜单里关回。仍可随时结束会话。"
            onClick={onTrust}
          >
            以后不再询问
          </button>
        )
      )}
      <span className={styles.meta}>
        {session.capability === "control"
          ? "对方可操作键鼠与剪贴板 · 你随时可结束"
          : "对方仅可观看画面 · 你随时可结束"}
      </span>
      {/* U1：与工作台被控视图同一道 danger 确认——按钮紧挨着「恢复外放」这类
          高频钮，误触「结束会话」的代价（对方画面全断）远大于多点一下确认。 */}
      <button
        type="button"
        className={styles.dangerBtn}
        disabled={busy}
        onClick={() => {
          void (async () => {
            const ok = await confirmDialog({
              title: "结束远程会话",
              message: `将断开与「${
                session.peer_name || fingerprintOf(session.peer)
              }」的连接。对方会立刻失去画面与控制。`,
              confirmText: "结束会话",
              variant: "danger",
            });
            if (ok) onEnd();
          })();
        }}
      >
        立即结束
      </button>
    </div>
  );
}
