/**
 * RcA2TagFilterRow — 侧栏的标签筛选 chip 行（2026-09-26 对齐稿①）。
 *
 * 只有存在带标签的设备才渲染（无标签设备一台都不画，空态不留占位）。
 * 多选、任一命中（OR）；颜色跟着 chip 上的同名标签首次出现的取值走
 * （`distinctTagsOf` 收口），与行上点堆同一白名单口径。
 */
import type { RcDeviceTag } from "@/lib/api/rc";
import { distinctTagsOf, tagColorOf } from "@/lib/rcDeviceTags";
import styles from "./RemoteComputerA2.module.css";

export function RcA2TagFilterRow({
  targets,
  selected,
  onChange,
}: {
  targets: { tags?: RcDeviceTag[] }[];
  selected: string[];
  onChange: (next: string[]) => void;
}) {
  const allTags = distinctTagsOf(targets);
  if (allTags.length === 0) return null;
  return (
    <div className={styles.tagFilterRow} role="group" aria-label="按标签筛选">
      {allTags.map((tag) => {
        const on = selected.includes(tag.name);
        return (
          <button
            key={tag.name}
            type="button"
            className={on ? styles.tagChipOn : styles.tagChip}
            aria-pressed={on}
            onClick={() =>
              onChange(on ? selected.filter((n) => n !== tag.name) : [...selected, tag.name])
            }
          >
            <i data-color={tagColorOf(tag)} aria-hidden="true" />
            {tag.name}
          </button>
        );
      })}
    </div>
  );
}
