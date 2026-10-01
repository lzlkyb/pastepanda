/**
 * ModifierKeyBar — 修饰键条 + 功能键行 + 打字/直传切换（design §5.2/§5.3）。
 *
 * 修饰键 sticky：点按挂起（青色高亮 = 已向远端发 down），组合完成后由
 * useModifierKeys 自动解除；再点 = 取消。功能键（Tab/Esc/Del/方向）点按
 * 即发 down+up 对，若有修饰键挂起则构成组合（Ctrl+Alt+Del 场景）。
 */
import { MOD_KEYS } from "./useModifierKeys";
import type { MobileKeyMode } from "./SessionToolbar";
import styles from "./RcMobileSession.module.css";

const FN_KEYS: Array<{ label: string; vk: number }> = [
  { label: "Tab", vk: 0x09 },
  { label: "Esc", vk: 0x1b },
  { label: "Del", vk: 0x2e },
  { label: "◀", vk: 0x25 },
  { label: "▲", vk: 0x26 },
  { label: "▼", vk: 0x28 },
  { label: "▶", vk: 0x27 },
];

export function ModifierKeyBar({
  pending,
  onToggleMod,
  onFunctionKey,
  keyMode,
  onPickKeyMode,
}: {
  /** 挂起中的修饰键 id 列表（青色高亮）。 */
  pending: string[];
  onToggleMod: (id: string) => void;
  onFunctionKey: (vk: number) => void;
  keyMode: MobileKeyMode;
  onPickKeyMode: (mode: MobileKeyMode) => void;
}) {
  return (
    <div className={styles.modifierBar}>
      <div className={styles.modRow}>
        {MOD_KEYS.map((m) => (
          <button
            key={m.id}
            type="button"
            className={`${styles.mkKey} ${pending.includes(m.id) ? styles.mkSticky : ""}`}
            onClick={() => onToggleMod(m.id)}
          >
            {m.label}
          </button>
        ))}
        <span className={styles.mkSep} aria-hidden="true" />
        {FN_KEYS.map((f) => (
          <button key={f.label} type="button" className={styles.mkKey} onClick={() => onFunctionKey(f.vk)}>
            {f.label}
          </button>
        ))}
      </div>
      {/* 打字/直传两档显式切换（对标桌面乙-① §6.7：不做自动判定） */}
      <div className={styles.modeRow}>
        <button
          type="button"
          className={`${styles.modeBtn} ${keyMode === "type" ? styles.modeOn : ""}`}
          onClick={() => onPickKeyMode("type")}
        >
          打字
        </button>
        <button
          type="button"
          className={`${styles.modeBtn} ${keyMode === "direct" ? styles.modeOn : ""}`}
          onClick={() => onPickKeyMode("direct")}
        >
          直传
        </button>
        <span className={styles.modeHint}>{keyMode === "type" ? "中文走整串注入" : "逐键直发（游戏/快捷键）"}</span>
      </div>
    </div>
  );
}
