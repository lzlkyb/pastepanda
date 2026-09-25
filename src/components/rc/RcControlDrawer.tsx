/**
 * RcControlDrawer — 被控抽屉（方案 B，2026-09-24）。
 *
 * 从 RcControlBanner 拆出（.tsx ≤ 300 红线）：胶囊负责「常驻极轻」，这里负责
 * 「点开才见的全部详情」——提示条（范围/推流档位/扬声器）/ 文件请求完整卡片 /
 * 事实表（指纹·范围·画质·免确认）/ 不发送声音 / 免确认二段确认（U9）/ 立即结束。
 * 渲染时机由父组件决定（open && <RcControlDrawer …/>）。
 */
import { useEffect, useState } from "react";
import { Volume2, VolumeX } from "lucide-react";
import { fingerprintOf } from "@/lib/fingerprint";
import { rcDisplayName } from "@/lib/rcDevice";
import { scopeLabelLong } from "@/lib/rcScope";
import { qualityHudLabel, qualityLabel } from "@/lib/rcQuality";
import { useRcFile } from "@/hooks/useRcFile";
import type { RcSession } from "@/lib/api/rc";
import { RcFileAskCard } from "./RcFileAsk";
import styles from "./RemoteComputer.module.css";

export function RcControlDrawer({
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
  quality,
  activeQuality,
  captureScope,
}: {
  session: RcSession;
  busy: boolean;
  trusted?: boolean;
  onTrust?: () => void;
  onEnd: () => void;
  scopeNotice?: string | null;
  onDismissScopeNotice?: () => void;
  streamNotice?: { kind: string; name: string } | null;
  onDismissStreamNotice?: () => void;
  audioLocalMute?: boolean;
  onToggleAudioLocalMute?: () => void;
  spkMutedByPeer?: boolean;
  onRestoreSpk?: () => void;
  quality?: string;
  activeQuality?: string;
  captureScope?: string;
}) {
  const canControl = session.capability === "control";
  const name = rcDisplayName(session, fingerprintOf(session.peer));

  // U9：开启免确认的行内二段确认（自 RcInboundView 迁移）——降低安全门槛的操作
  // 不该一键生效；收紧方向保持一键。会话切换时复位展开态。
  const [confirmTrust, setConfirmTrust] = useState(false);
  useEffect(() => setConfirmTrust(false), [session.id]);

  return (
    <>
      {/* 提示条：一次性状态变化（范围 / 推流档位 / 扬声器），任何宽度下可读 */}
      {(scopeNotice || streamNotice || spkMutedByPeer) && (
        <div className={styles.ctrlNotes}>
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
          {streamNotice && (
            <span className={styles.scopeNotice} role="status" aria-live="polite">
              {streamNotice.kind === "audio"
                ? streamNotice.name === "off"
                  ? "对方已停止接收本机系统声音"
                  : // ❗ 本机已静音时「对方能听到」是假话（一票否决）。宁啰嗦不骗人。
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
          {spkMutedByPeer && (
            <span className={styles.scopeNotice} role="status" aria-live="polite">
              对方静音了本机扬声器外放
              {onRestoreSpk && (
                <button
                  type="button"
                  className={styles.scopeNoticeX}
                  disabled={busy}
                  onClick={onRestoreSpk}
                >
                  恢复外放
                </button>
              )}
            </span>
          )}
        </div>
      )}

      {/* G6：文件请求完整卡片——「有东西要写进我的磁盘」是现在就要做的决定，
          摆核对用的事实（指纹 / 文件名 / 大小）。B6：全部待响应请求都摆出来。 */}
      <DrawerFiles session={session} busy={busy} />

      {/* 事实表：指纹是身份锚点，范围和画质是「我交出去了什么」。 */}
      <dl className={styles.ibFacts}>
        <div className={styles.ibFact}>
          <dt>对方指纹</dt>
          <dd>{fingerprintOf(session.peer)}</dd>
        </div>
        <div className={styles.ibFact}>
          <dt>画面范围</dt>
          <dd>{scopeLabelLong(captureScope ?? "virtual")}</dd>
        </div>
        <div className={styles.ibFact}>
          <dt>本机画质</dt>
          <dd>{quality ? qualityHudLabel(quality, activeQuality) : "—"}</dd>
        </div>
        <div className={styles.ibFact}>
          <dt>免确认</dt>
          <dd>{trusted ? "已开启（对方下次直接连入）" : "未开启（每次都问你）"}</dd>
        </div>
      </dl>

      <div className={styles.ctrlFoot}>
        {canControl
          ? "对方可操作键鼠与剪贴板 · 你随时可结束"
          : "对方仅可观看画面 · 你随时可结束"}
      </div>

      <div className={styles.ctrlDrawerActs}>
        {/* G3：本机静音是一票否决，提为抽屉里的一级操作。 */}
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
                : "对方将听不到本机播放的系统声音（不影响画面与控制）。关了就跨会话保持，直到你点回来。"
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
        {/* A2：开的是「不再逐次询问」，不是「无人值守」——文案必须说清边界。 */}
        {trusted ? (
          <span
            className={styles.trustOn}
            title="这台设备下次发起远程会直接连入；可在设备菜单里恢复逐次询问"
          >
            已免确认
          </span>
        ) : (
          onTrust &&
          (confirmTrust ? (
            <span className={styles.trustWarn} role="alertdialog" aria-label="确认开启免确认">
              <b>对「{name}」开启免确认？</b>
              <span>开启后这台设备连入本机不再弹确认，仍可随时结束会话。</span>
              <span className={styles.trustWarnBtns}>
                <button
                  type="button"
                  className={styles.miniBtnPri}
                  disabled={busy}
                  onClick={() => {
                    setConfirmTrust(false);
                    onTrust();
                  }}
                >
                  确认开启
                </button>
                <button
                  type="button"
                  className={styles.miniBtn}
                  disabled={busy}
                  onClick={() => setConfirmTrust(false)}
                >
                  先不
                </button>
              </span>
            </span>
          ) : (
            <button
              type="button"
              className={styles.miniBtn}
              disabled={busy}
              title="这台设备以后发起远程时直接连入，不再弹确认；可随时在设备菜单里关回。仍可随时结束会话。"
              onClick={() => setConfirmTrust(true)}
            >
              开启免确认
            </button>
          ))
        )}
        <span className={styles.sp} />
        <button
          type="button"
          className={styles.dangerBtn}
          disabled={busy}
          onClick={onEnd}
        >
          立即结束
        </button>
      </div>
    </>
  );
}

/** 文件请求卡片列表。useRcFile 在此独立订阅（父组件那份只用于徽标/自动展开判定）。 */
function DrawerFiles({
  session,
  busy,
}: {
  session: RcSession;
  busy: boolean;
}) {
  const file = useRcFile(session.peer);
  return (
    <>
      {file.asks.map((a) => (
        <RcFileAskCard key={a.id} ask={a} busy={busy} onRespond={file.respond} />
      ))}
    </>
  );
}
