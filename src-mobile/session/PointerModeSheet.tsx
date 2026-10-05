import { MobileSheet } from "../ui/MobileSheet";
import { MousePointer2 } from "lucide-react";
import { POINTER_MODES, type PointerMode } from "./pointerModes";
import ui from "../ui/MobileUi.module.css";
import styles from "./RcMobileSession.module.css";

export function PointerModeSheet({
  open,
  onClose,
  mode,
  onMode,
  mouseOpen,
  onMouse,
  enabled = true,
}: {
  open: boolean;
  onClose: () => void;
  mode: PointerMode;
  onMode: (mode: PointerMode) => void;
  mouseOpen: boolean;
  onMouse: () => void;
  enabled?: boolean;
}) {
  return (
    <MobileSheet open={open} title="操作方式" onClose={onClose}>
      <div className={styles.panelActions}>
        {(Object.keys(POINTER_MODES) as PointerMode[]).map((value) => (
          <button
            key={value}
            type="button"
            className={styles.pointerOption}
            aria-pressed={mode === value}
            disabled={!enabled}
            onClick={() => {
              onMode(value);
              onClose();
            }}
          >
            <MousePointer2 size={22} aria-hidden="true" />
            <span className={styles.pointerOptionText}>
              <strong>{POINTER_MODES[value].label}{value === "trackpad" ? " · 推荐默认" : ""}</strong>
              <span>{POINTER_MODES[value].description}</span>
            </span>
            {mode === value && <span className={styles.pointerSelected}>已选</span>}
          </button>
        ))}
        <p className={styles.panelHint}>自动记住这部手机的选择，下次连接继续使用。</p>
        <button type="button" className={ui.secondary} disabled={!enabled} onClick={() => {
          onMode("trackpad");
          onClose();
        }}>恢复推荐默认</button>
        {(mode === "trackpad" || mode === "direct") && <details>
        <summary className={styles.pointerAdvanced}>辅助选项</summary>
        <button
          type="button"
          className={ui.secondary}
          aria-pressed={mouseOpen}
          disabled={!enabled}
          onClick={() => {
            onMouse();
            onClose();
          }}
        >
          {mouseOpen ? "收起" : "展开"}鼠标辅助
        </button>
        </details>}
        <p className={styles.panelHint}>
          {mode === "pad" || mode === "floating"
            ? "画面手势只调整本地视野；电脑操作使用触控板或控制柄。右键、拖拽和滚动都有按钮入口。"
            : "右键、拖拽和滚动可用辅助按钮完成。长按松手右键，长按移动拖拽；双指平移滚动电脑页面，捏合调整视野。"}
        </p>
      </div>
    </MobileSheet>
  );
}
