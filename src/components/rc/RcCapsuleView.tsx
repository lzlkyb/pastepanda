/**
 * RcCapsuleView — 胶囊的**流控 + 视图段**（自 RcSessionCapsule 抽出，2026-09-28
 * 方案 A 前置拆薄，`.tsx ≤ 300` 红线）。
 *
 * 画质（流控，只看也能调）→ 画面范围 / 下一屏（要求可控：改的是主机采集范围）
 * → **键盘模式两档**（乙-①，要求可控：它改的是「对方的机器怎么被按键」）→
 * 适应 / 1:1 / 填充三键（本机显示）→ 全屏键。这一段的值全走
 * `useRcRemoteSend` 的乐观更新 + 失败回滚，本组件只负责摆与禁用。
 *
 * 🔴 `sendAvailable`（链路 connected）是这段的统一门禁：send_input 是乐观写流，
 * 链路半死时写本地缓冲即返回 Ok——值跳了画面永远没反应且无报错。
 */
import { Maximize2 } from "lucide-react";
import type { FitMode } from "@/lib/rcSessionStats";
import { rcKeyModeLabel, rcKeyModeTip, type RcKeyMode } from "@/lib/rcKeyMode";
import { rcLockButtonOf } from "@/lib/rcInputGate";
import type { RcCaptureScope, RcPeerInputState, RcQuality } from "@/lib/api/rc";
import type { UseRc } from "@/hooks/useRc";
import type { useRcRemoteSend } from "@/hooks/useRcRemoteSend";
import { RcDropdown } from "./RcDropdown";
import styles from "./RemoteComputer.module.css";

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

/** 乙-①：两档都摆出来（点哪档就是哪档），不做「自动」这一档——对标 §6.7 的结论。 */
const KEY_MODES: RcKeyMode[] = ["type", "direct"];

export function RcCapsuleView({
  rc,
  send,
  quality,
  scopePick,
  canControl,
  sendAvailable,
  fit,
  onFit,
  keyMode,
  onPickKeyMode,
  fullscreen,
  onToggleFullscreen,
  peerInput,
  tab,
  menuDelta,
}: {
  rc: UseRc;
  send: RcSend;
  quality: string;
  scopePick: string;
  canControl: boolean;
  /** 链路是否可用（见文件头 🔴）。 */
  sendAvailable: boolean;
  fit: FitMode;
  onFit: (m: FitMode) => void;
  /** 乙-①：当前键盘模式（打字 / 直传）。 */
  keyMode: RcKeyMode;
  onPickKeyMode: (m: RcKeyMode) => void;
  /** 乙-③：对端报来的主机输入权状态（决定「锁定对方」可否点、现在是什么态）。 */
  peerInput?: RcPeerInputState | null;
  /** 全屏态：同一颗键翻转语义（进入 ↔ 退出）。 */
  fullscreen: boolean;
  onToggleFullscreen: () => void;
  tab?: number;
  menuDelta: (open: boolean) => void;
}) {
  const lock = rcLockButtonOf(peerInput);
  return (
    <>
      {/* D-2：只看仍可调画质/编码（流控）；画面范围要求可控（改主机采集范围） */}
      <RcDropdown
        label="画质"
        value={quality as RcQuality}
        options={send.qualities}
        columns={2}
        disabled={rc.busy || !sendAvailable}
        disabledTitle={sendAvailable ? undefined : "链路未连通，暂不能改画质；连通后可再调"}
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
            disabledTitle={sendAvailable ? undefined : "链路未连通，暂不能改画面范围；连通后可再调"}
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
              title={sendAvailable ? "切换到对方的下一块显示器（循环）" : "链路未连通，暂不能切屏"}
              onClick={send.cycleScreen}
            >
              下一屏
            </button>
          )}
        </>
      )}
      {/* 🔴 乙-①：键盘模式两档（要求可控——它改的是「对方的机器怎么被按键」，
          与画面范围同量级，不是「我自己看什么」）。两档都摆、点了就切，
          没有「自动」这一档：对标 §6.7 六家都没做成的自动判定，我们不做。 */}
      {canControl && (
        <>
          <span className={styles.capSep} aria-hidden="true" />
          <span className={styles.capFit}>
            {KEY_MODES.map((m) => (
              <button
                key={m}
                type="button"
                tabIndex={tab}
                className={keyMode === m ? `${styles.capBtn} ${styles.capBtnOn}` : styles.capBtn}
                title={rcKeyModeTip(m)}
                onClick={() => onPickKeyMode(m)}
              >
                {rcKeyModeLabel(m)}
              </button>
            ))}
            {/* 🔴 乙-③：锁的是**对方本人的物理键鼠**，钥匙在对方手里——他没勾
                「允许对方锁定我的输入」这颗键就不可点，且原因要说清是「没授权」
                还是「没这个功能」（判据见 rcLockButtonOf）。生效与否也不做乐观：
                真值等对方钩子回帧。 */}
            <button
              type="button"
              tabIndex={tab}
              className={lock.on ? `${styles.capBtn} ${styles.capBtnOn}` : styles.capBtn}
              disabled={!lock.enabled || rc.busy || !sendAvailable}
              title={!sendAvailable && lock.enabled ? "链路未连通，暂不能锁定对方输入" : lock.tip}
              onClick={() => send.sendInputLock(!lock.on)}
            >
              {lock.label}
            </button>
          </span>
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
      {/* 稿子 §3-A①：非全屏是图标键（⤢ 同族），全屏翻成**文字**「退出全屏」——
          退出是全屏里最要紧的一步，且此刻没有别的图标可参照它叫什么。 */}
      <button
        type="button"
        tabIndex={tab}
        className={styles.capBtn}
        title={fullscreen ? "退出全屏显示远程画面（F11）" : "全屏显示远程画面（F11）"}
        onClick={onToggleFullscreen}
      >
        {fullscreen ? "退出全屏" : <Maximize2 size={13} aria-hidden="true" />}
      </button>
    </>
  );
}
