/**
 * RcCapsuleMore — 控端浮条「⋯」面板（2026-09-24 控端态 UI 方案 B 收编）。
 *
 * 低频项的二级收纳位（A/B 稿 §3 同款，浮条本体只留高频：画质/画面/视图/结束）。
 * 内容按使用频率分组：
 *
 * - 传输与声音：码率下拉（原底栏的码率下拉整体搬入）+ 声音组（RcAudioBar）+
 *   剪贴板组（RcClipboardBar，仅可控）。
 * - 文件：传/取文件（RcFileBar，仅可控——写对端磁盘与键鼠注入同级）。
 * - 输入：锁定指针 / 释放键盘。
 * - 会话：重连（断开并重新发起；confirmDialog 在父级，这里只触发）。
 *
 * 🔴 深色玻璃面板里的浅色控件：RcAudioBar / RcClipboardBar / RcFileBar 的按钮
 *    类（menuBtn/miniBtn）是浅底语义，在深面板上会糊——由 `.capMore` 后代
 *    选择器统一翻色（同 `.viewShell .miniBtn` 的既有先例），子组件零改动。
 * 🔴 面板展开期间浮条由父组件锁显（menusOpen / panelOpen），鼠标移进面板
 *    （DOM 上在浮条 root 内）不会触发淡出。
 */
import { Power, Pointer, Keyboard } from "lucide-react";
import type { UseRc } from "@/hooks/useRc";
import { RcDropdown, type RcDropdownOption } from "./RcDropdown";
import { RcAudioBar } from "./RcAudioBar";
import { RcClipboardBar } from "./RcClipboardBar";
import { RcFileBar } from "./RcFileBar";
import styles from "./RemoteComputer.module.css";

export function RcCapsuleMore({
  rc,
  canControl,
  bitrate,
  bitrateOptions,
  onPickBitrate,
  audioOn,
  onToggleAudio,
  clipAuto,
  onToggleClipAuto,
  lastAutoAt,
  autoFail,
  onStatus,
  pointerLocked,
  onTogglePointer,
  kbOn,
  onReleaseKb,
  onReconnect,
  busy,
}: {
  rc: UseRc;
  canControl: boolean;
  /** Q5：当前码率倍率（50–200，100 = 跟随链路）。 */
  bitrate: number;
  bitrateOptions: readonly RcDropdownOption<string>[];
  onPickBitrate: (pct: string) => void;
  audioOn: boolean;
  onToggleAudio: () => void;
  clipAuto: boolean;
  onToggleClipAuto: () => void;
  lastAutoAt: number;
  autoFail: number;
  onStatus: (msg: string, kind: "success" | "error" | "info") => void;
  pointerLocked: boolean;
  onTogglePointer: () => void;
  kbOn: boolean;
  onReleaseKb: () => void;
  onReconnect?: () => void;
  busy: boolean;
}) {
  // G6：文件操作组要对端 node_id——从会话里取；拿不到时 RcFileBar 自行不摆
  const peer = rc.status?.session?.peer ?? "";

  return (
    <div className={styles.capMore} role="group" aria-label="更多会话操作">
      <div className={styles.capMoreSec}>传输与声音</div>
      <div className={styles.capMoreBtns}>
        <RcDropdown
          label="码率"
          value={String(bitrate)}
          options={bitrateOptions}
          disabled={rc.busy}
          onPick={onPickBitrate}
        />
        <RcAudioBar
          rc={rc}
          canControl={canControl}
          audioOn={audioOn}
          onToggleAudio={onToggleAudio}
          onStatus={onStatus}
        />
        {canControl && (
          <RcClipboardBar
            clipAuto={clipAuto}
            onToggleAuto={onToggleClipAuto}
            lastAutoAt={lastAutoAt}
            autoFail={autoFail}
            onStatus={onStatus}
          />
        )}
      </div>

      {canControl && (
        <>
          <div className={styles.capMoreSec}>文件</div>
          <div className={styles.capMoreBtns}>
            <RcFileBar peer={peer} />
          </div>
        </>
      )}

      <div className={styles.capMoreSec}>输入</div>
      <div className={styles.capMoreRows}>
        {canControl && (
          <button
            type="button"
            className={styles.capMoreRow}
            title={pointerLocked ? "解除系统指针捕获" : "捕获系统指针，拖出画面边缘不丢事件"}
            onClick={onTogglePointer}
          >
            <Pointer size={13} aria-hidden="true" />
            <span className={styles.capMoreLab}>{pointerLocked ? "解锁系统指针" : "锁定系统指针"}</span>
            <span className={styles.capMoreCur}>{pointerLocked ? "已锁定" : "未锁定"}</span>
          </button>
        )}
        {canControl && kbOn && (
          <button
            type="button"
            className={styles.capMoreRow}
            title="释放键盘捕获（Esc 同效）"
            onClick={onReleaseKb}
          >
            <Keyboard size={13} aria-hidden="true" />
            <span className={styles.capMoreLab}>释放键盘</span>
            <span className={styles.capMoreCur}>Esc</span>
          </button>
        )}
      </div>

      {onReconnect && (
        <>
          <div className={styles.capMoreSec}>会话</div>
          <div className={styles.capMoreRows}>
            <button
              type="button"
              className={`${styles.capMoreRow} ${styles.capMoreDanger}`}
              disabled={busy}
              title="断开当前连接并重新发起"
              onClick={onReconnect}
            >
              <Power size={13} aria-hidden="true" />
              <span className={styles.capMoreLab}>重连</span>
              <span className={styles.capMoreCur}>断开并重新发起</span>
            </button>
          </div>
        </>
      )}
    </div>
  );
}
