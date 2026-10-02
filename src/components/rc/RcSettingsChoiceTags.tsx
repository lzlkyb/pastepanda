import styles from "./RemoteComputer.module.css";

/** 档位胶囊组（外形与 RcQualityBar 的 .pill 同款，语义各自独立）。 */
export function RcSettingsChoiceTags<T extends string>({
  value,
  label,
  options,
  disabled,
  onPick,
}: {
  value: T;
  label: string;
  options: readonly { key: T; label: string; tip?: string }[];
  disabled?: boolean;
  onPick: (v: T) => void;
}) {
  return (
    <div className={styles.qRow} role="group" aria-label={label}>
      {options.map(({ key, label, tip }) => (
        <button
          key={key}
          type="button"
          title={tip}
          disabled={disabled}
          aria-pressed={value === key}
          className={value === key ? styles.pillOn : styles.pill}
          onClick={() => onPick(key)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
