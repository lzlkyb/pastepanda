import { Monitor, RotateCw } from "lucide-react";
import { MobileSheet } from "../ui/MobileSheet";
import { MobileNotice } from "../ui/MobileNotice";
import { MobileChoice } from "../ui/MobileChoice";
import { SessionSettingFeedback } from "./SessionSettingFeedback";
import type { SessionToolbarProps } from "./SessionToolbar";
import { MOBILE_QUALITY_CYCLE } from "./qualityCycle";
import { qualityLabel } from "@/lib/rcQuality";
import { rcErrorText } from "../devices/rcErrorText";
import ui from "../ui/MobileUi.module.css";
import styles from "./RcMobileSession.module.css";

export type SessionPanel = "screen" | "more" | "end" | "mode";

/** One sheet owns these routes. Back restores its source; close ends the tool flow. */
export function SessionToolbarPanels({ panel, onBack, onClose, onScreen, onExit, onClipboard, onConnection, ...props }: SessionToolbarProps & {
  panel: SessionPanel | null;
  onBack?: () => void;
  onClose: () => void;
  onScreen: () => void;
  onExit: () => void;
  onClipboard: () => void;
  onConnection: () => void;
}) {
  const { landscape, quality, settings, orientationHint, onOrientationHintDismiss, onResetZoom,
    onToggleOrientation, onRevealPointer, onPickQuality, audioOn, onToggleAudio, onConnectionDetails,
    inputReady = true, canControl = true, pointerMode = "trackpad", onEnd, ending, endError, waiting = false } = props;
  const title = panel === "screen" ? "画面" : panel === "more" ? "更多" : waiting ? "取消连接申请" : "断开连接？";
  const footer = panel === "screen" ? <>
    <SessionSettingFeedback state={settings?.items.quality} onRetry={() => void settings?.retry("quality")} />
    {orientationHint && <MobileNotice compact tone="error" title="显示方向未能切换" detail={orientationHint} onDismiss={onOrientationHintDismiss} />}
  </> : panel === "more" && settings?.items.audio
    ? <SessionSettingFeedback state={settings.items.audio} onRetry={() => void settings.retry("audio")} /> : undefined;
  return <MobileSheet open={panel !== null && panel !== "mode"} title={title} onClose={onClose} onBack={onBack}
    description={panel === "end" && !waiting ? "结束会话后返回设备，电脑上的工作会继续保留。" : undefined} footer={footer}>
    {panel === "screen" && <div className={styles.panelActions}>
      <h3 className={ui.sectionHeading}>画质</h3>
      <div className={styles.qualityChoices} role="radiogroup" aria-label="画质">
        {MOBILE_QUALITY_CYCLE.map(value => <MobileChoice key={value} value={value} checked={quality === value}
          title={qualityLabel(value)} onSelect={() => onPickQuality(value)} />)}
      </div>
      <button type="button" className={ui.secondary} onClick={() => { onResetZoom(); onClose(); }}>适应屏幕</button>
      <button type="button" className={ui.secondary} onClick={onToggleOrientation}>
        <RotateCw size={18} aria-hidden="true" />{landscape ? "切换到竖屏" : "切换到横屏"}
      </button>
      <button type="button" className={ui.secondary} onClick={() => { onRevealPointer?.(); onClose(); }}>回到指针</button>
      <details className={styles.qualityDetails}><summary>画质策略与操作手势</summary>
      <p className={styles.panelHint}>选「清晰 / 均衡 / 流畅」会锁档并关闭电脑自动档；点「自动」恢复。</p>
      {!quality && <p className={styles.panelHint}>当前电脑画质尚未确认，选择档位后等待电脑确认。</p>}
      {quality === "auto" && <p className={styles.panelHint}>电脑正按网络状况自动换档。</p>}
      {quality && quality !== "auto" && <p className={styles.panelHint}>已锁档「{qualityLabel(quality)}」：电脑自动档已关闭，点「自动」恢复。</p>}
      <p className={styles.panelHint}>{pointerMode === "pad" || pointerMode === "floating"
        ? "画面手势调整本地视野；用触控板或控制柄操作电脑。"
        : "双指捏合缩放画面，双指移动滚动电脑页面。"}</p>
      </details>
    </div>}
    {panel === "more" && <div className={styles.panelActions}>
      {onConnectionDetails && <button type="button" className={ui.secondary} onClick={onConnection}>连接详情</button>}
      <button type="button" className={ui.secondary} onClick={onScreen}><Monitor size={18} aria-hidden="true" />画面与画质</button>
      <button type="button" className={ui.secondary} disabled={!canControl || !inputReady} onClick={onClipboard}>剪贴板</button>
      {!canControl && <MobileNotice>当前会话只观看画面，键盘和剪贴板不可用。</MobileNotice>}
      <button type="button" className={ui.secondary} aria-pressed={audioOn} onClick={onToggleAudio}>{audioOn ? "关闭电脑声音" : "开启电脑声音"}</button>
      <p className={styles.panelHint}>电脑声音默认关闭，开启后通过手机播放。</p>
      <button type="button" className={ui.danger} onClick={onExit}>{waiting ? "取消连接申请" : "断开连接"}</button>
    </div>}
    {panel === "end" && <div className={styles.panelActions}>
      {endError && <MobileNotice error title={waiting ? "申请未能取消" : "连接未能断开"} detail={rcErrorText(endError)} />}
      {waiting && !endError && <MobileNotice tone="pending" title="正在取消连接申请…" />}
      {(!waiting || endError) && <button type="button" className={ui.danger} disabled={ending} onClick={onEnd}>
        {ending ? "正在断开…" : waiting ? "重试取消申请" : "确认断开"}
      </button>}
      <button type="button" className={ui.secondary} disabled={ending} onClick={onBack ?? onClose}>{waiting ? "继续等待" : "继续连接"}</button>
    </div>}
  </MobileSheet>;
}
