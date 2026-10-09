import type { ReactNode } from "react";
import { Check } from "lucide-react";
import styles from "./MobileChoice.module.css";

/** One visual selection language; submission buttons keep their action semantics. */
export function MobileChoice({ value, checked, onSelect, title, description, disabled, icon }: {
  value: string;
  checked: boolean;
  onSelect: () => void;
  title: string;
  description?: ReactNode;
  disabled?: boolean;
  icon?: ReactNode;
}) {
  return <button type="button" className={styles.choice} role="radio" aria-checked={checked}
    data-value={value} disabled={disabled} onClick={onSelect} onKeyDown={event => {
      const moves = ["ArrowRight", "ArrowDown", "ArrowLeft", "ArrowUp", "Home", "End"];
      if (!moves.includes(event.key)) return;
      const group = event.currentTarget.closest('[role="radiogroup"]');
      if (!group) return;
      const options = [...group.querySelectorAll<HTMLButtonElement>('[role="radio"]:not(:disabled)')];
      const current = options.indexOf(event.currentTarget);
      const next = event.key === "Home" ? 0 : event.key === "End" ? options.length - 1
        : (current + (["ArrowLeft", "ArrowUp"].includes(event.key) ? -1 : 1) + options.length) % options.length;
      event.preventDefault(); options[next]?.focus(); options[next]?.click();
    }}>
    {icon && <span className={styles.icon} aria-hidden="true">{icon}</span>}
    <span className={styles.copy}><strong>{title}</strong>{description && <span className={styles.description}>{description}</span>}</span>
    <span className={styles.check} aria-hidden="true">{checked && <Check size={20} />}</span>
  </button>;
}
