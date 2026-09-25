/**
 * RcAudioBar — 会话里的「声音」组（G3 / G3-B / G3-C，2026-09-20；2026-09-24 起
 * 住在 RcSessionCapsule 的「⋯」面板，原会话底栏已删）。
 *
 * 三件事挤在一个按钮上就会撒谎，所以拆成三格：
 *
 * 1. **声音开关**（本机听不听对方）—— 会话中随时可切，被控端横幅有可见提示。
 * 2. **对方已静音**（G3-B）—— 对端按了「不发送声音」时如实说出来。
 *    这是 G3 首版唯一的空白：对端静音了却不吭声，我们这边只表现为「没声音」，
 *    用户无从判断是对方不想给、还是链路/设备坏了（RustDesk 同类 issue 挂了两年）。
 * 3. **对方外放**（G3-C）—— 让**对方主机**本地喇叭闭嘴，屋里不被打扰，
 *    而**串流照旧**（WASAPI 抽头在端点静音之前，我们这边照样听得到）。
 *
 * 🔴 第 3 条**要求 Control**：它改的是对端的物理输出环境，与「改画质」那类
 *    只影响自己画面的指令不同档（和键鼠注入同级）。只看会话不摆这个按钮
 *    ——摆了也必被对端拒绝，那才是真的「点了没反应」。
 *
 * 🔴 按钮态一律以**后端快照**为准（`peer_audio.spk_mute`），不做乐观置位：
 *    「点了没反应还说已保存」是本仓库反复修过的那类谎话（见 `RcSessionBar` 注释）。
 */
import { useState } from "react";
import { Volume2, VolumeX, VolumeOff } from "lucide-react";
import { rcSendInput } from "@/lib/api/rc";
import type { UseRc } from "@/hooks/useRc";
import styles from "./RemoteComputer.module.css";

export function RcAudioBar({
  rc,
  canControl,
  audioOn,
  onToggleAudio,
  onStatus,
}: {
  rc: UseRc;
  canControl: boolean;
  /** G3：本机是否在听对方的声音（默认开）。 */
  audioOn: boolean;
  onToggleAudio: () => void;
  onStatus: (msg: string, kind: "success" | "error" | "info") => void;
}) {
  // null = 旧对端不发 host_audio 帧 → 相关断言一概不摆（不猜）
  const peer = rc.status?.peer_audio ?? null;
  const peerSilent = peer?.local_mute === true;
  const peerSpkMuted = peer?.spk_mute === true;
  const [busy, setBusy] = useState(false);

  const togglePeerSpk = async () => {
    if (busy) return;
    setBusy(true);
    try {
      // 只发意图；按钮态等对端回帧（带读回的真实值）落到快照再变
      await rcSendInput({ kind: "set_host_mute", on: !peerSpkMuted });
    } catch (e) {
      onStatus(`切换对方扬声器失败：${e}`, "error");
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <button
        type="button"
        className={styles.menuBtn}
        title={
          audioOn
            ? "关闭系统声音（不再听对端播放的声音）"
            : "开启系统声音（听对端播放的声音）"
        }
        onClick={onToggleAudio}
      >
        {audioOn ? <Volume2 size={14} aria-hidden="true" /> : <VolumeX size={14} aria-hidden="true" />}
        声音
      </button>
      {/* G3-B：对端静音的如实告知。不说出来就只剩「没声音」这一种观感。
          U5：本机也关着时合并说「双方都静音」——两个独立开关图标都是静音系，
          不点破「两个人各自关了自己的那一侧」，用户无从判断该找谁开。 */}
      {peerSilent && (
        <span
          className={styles.audioPeerOff}
          role="status"
          title={
            audioOn
              ? "对方在本机静音了系统声音（对方可见、可自行恢复）"
              : "你关了「声音」，对方也静音了发送——想听先开「声音」，对方那边恢复外放"
          }
        >
          {audioOn ? "对方已静音" : "双方都静音"}
        </span>
      )}
      {/* G3-C：只在可控会话摆——「只看」下对端必拒，摆了就是假按钮 */}
      {canControl && (
        <>
          <button
            type="button"
            className={peerSpkMuted ? `${styles.menuBtn} ${styles.menuBtnOn}` : styles.menuBtn}
            disabled={busy}
            aria-pressed={peerSpkMuted}
            title={
              peerSpkMuted
                ? "恢复对方主机的扬声器外放"
                : "静音对方主机的扬声器外放（屋里不被打扰；你这边照样能听到声音）"
            }
            onClick={() => void togglePeerSpk()}
          >
            <VolumeOff size={14} aria-hidden="true" />
            对方外放
          </button>
          {/* 对端执行失败的原因随快照带回（它对端没有能显示这条的横幅） */}
          {peer?.err && (
            <span className={`${styles.fb} ${styles.fbBad}`} title={peer.err}>
              对方无法切换扬声器
            </span>
          )}
        </>
      )}
    </>
  );
}
