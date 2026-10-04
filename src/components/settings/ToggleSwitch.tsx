/**
 * ToggleSwitch — `sToggle` 那个 44×26 开关本体，抽出来给「行结构已经定了」的调用点用。
 *
 * 为什么不是直接用 `ToggleRow`：`ToggleRow` 自带整行（彩砖 + label + desc），而折叠组里的
 * 行是 `RcGroupRow`（右控件列只有 72–96px）。原来这段 JSX 在三个文件里各抄了一份，
 * 这里先收口成一处，供 `RcGroupRow` 的行内使用；`ToggleRow` 改为转调它。
 *
 * `disabled` 是这条的要点：被控上限组里「通道没开 ⇒ 控件禁用、但整行仍要看得懂」，
 * 裸 `ToggleRow` 没有这个态（它的开关永远可点）。
 */
import styles from "../Settings.module.css";

export function ToggleSwitch({
  value,
  onChange,
  disabled,
  disabledTitle,
}: {
  value: boolean;
  onChange: (v: boolean) => void;
  disabled?: boolean;
  /** 禁用原因（悬停说明）。禁用却不解释 = 用户以为是坏了。 */
  disabledTitle?: string;
}) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value}
      className={`${styles.sToggle} ${value ? styles.on : styles.off}`}
      disabled={disabled}
      title={disabled ? disabledTitle : undefined}
      onClick={(e) => {
        e.stopPropagation();
        onChange(!value);
      }}
    >
      <span className={styles.sToggleThumb} />
      <span className={styles.sToggleLabel}>{value ? "开" : "关"}</span>
    </button>
  );
}
