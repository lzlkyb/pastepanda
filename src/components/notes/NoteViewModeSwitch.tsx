/**
 * 笔记编辑器的形态切换器（仅编辑 / 分屏 / 仅预览）。
 *
 * ❗ 按钮的 key / 文案 / 图标 / 顺序全部来自 `TRI_MODES`——与全屏 Markdown
 *   编辑器**同一份定义**（规则 #11）。自己再列一遍三个按钮看上去也能跑，
 *   但那一天全屏那边换了图标，这里不会跟着变——而「操作习惯统一」正是要防这个。
 *
 * 位置也对齐全屏编辑器：它在顶部工具栏，所以这里也放头部而不是底部那排。
 *
 * 🔴 红线：纯展示层，无 AI。
 */
import { useCallback, useEffect, useState } from "react";
import { TRI_MODES, type ViewMode } from "@/components/editors/fullscreen/types";
import styles from "./NoteViewModeSwitch.module.css";

/** 形态偏好的 localStorage 键。 */
const MODE_KEY = "pastepanda_note_view_mode";

function readSaved(): ViewMode | null {
  try {
    const raw = localStorage.getItem(MODE_KEY);
    return raw === "edit" || raw === "split" || raw === "preview" ? raw : null;
  } catch {
    // 隐私模式等读不了就当没存过。一个展示层偏好不能让编辑器打不开。
    return null;
  }
}

/**
 * 形态状态 + 持久化。
 *
 * **默认预览**：知识库里打开一条笔记绝大多数时候是去「读」的。
 *
 * ❗ `isNew`（新建空白 / 从卡片转）一律走 `edit`：那时正文是空的或刚粘进来的，
 *   预览一片空白没意义，而且“转笔记→立刻改”是个高频路径，不能让它多点一下。
 *   这一次的 `edit` **不写进偏好**，否则新建一次就把下次打开已有笔记的默认也改成了编辑。
 */
export function useNoteViewMode(isNew: boolean) {
  const [mode, setMode] = useState<ViewMode>(() => (isNew ? "edit" : (readSaved() ?? "preview")));

  useEffect(() => {
    if (isNew) return;
    try {
      localStorage.setItem(MODE_KEY, mode);
    } catch {
      // 写不进去不影响本次使用，下次回默认而已。
    }
  }, [mode, isNew]);

  return [mode, setMode] as const;
}

export function NoteViewModeSwitch({
  value,
  onChange,
  splitDisabled,
}: {
  value: ViewMode;
  onChange: (m: ViewMode) => void;
  /**
   * 容器太窄，分屏不可用。
   *
   * **置灰而不是隐藏**：拉窗口时按钮数量跳变比一个置灰的按钮更迷惑。
   * （这与规则 #16「AI 未启用就整个不渲染」不矛盾：那条说的是「未启用 = 零可见」，
   *   而这里能力是存在的、只是当前宽度放不下。）
   */
  splitDisabled?: boolean;
}) {
  const pick = useCallback(
    (m: ViewMode) => {
      if (m === "split" && splitDisabled) return;
      onChange(m);
    },
    [onChange, splitDisabled],
  );

  return (
    <div className={styles.wrap} role="group" aria-label="视图形态">
      {TRI_MODES.map(({ key, title, Icon }) => {
        const off = key === "split" && splitDisabled;
        return (
          <button
            key={key}
            type="button"
            className={`${styles.btn} ${value === key ? styles.on : ""}`}
            onClick={() => pick(key)}
            disabled={off}
            title={off ? "当前宽度不够，把窗口拉宽一些就能分屏" : title}
            aria-label={title}
            aria-pressed={value === key}
          >
            <Icon size={13} />
          </button>
        );
      })}
    </div>
  );
}
