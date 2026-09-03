/**
 * BatchBar.tsx —— 多选后的批量动作条（A2）。
 *
 * 单独成件而不是往 `KnowledgeView` 里堆：那个文件已经 780+ 行（规则 #7），
 * 而本组件自带一个文件夹下拉的开合状态，本来就是一块完整的展示层。
 *
 * ❗ 不复用右键菜单体系：`ContextMenu` 的 Provider 是 `KnowledgeView` 自己摆的，
 *   它作为 Provider 的父层拿不到那个 context。与其为此再套一层，
 *   不如自带一个只有一个用途的小下拉。
 *
 * 🔴 红线：无 AI。批量动作全走现有的单条 IPC。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { FolderInput, Library, Trash2, X } from "lucide-react";
import type { NoteFolder } from "@/lib/api";
import styles from "../KnowledgeView.module.css";

export function BatchBar({
  count,
  folders,
  onMove,
  onDelete,
  onClear,
}: {
  /** 已选条数。为 0 时调用方不渲染本组件。 */
  count: number;
  folders: NoteFolder[];
  /** `null` = 移回未分类。 */
  onMove: (folderId: string | null) => void;
  onDelete: () => void;
  onClear: () => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // 点外面 / Esc 关下拉。跟 `ViewControls` 同一套做法（mousedown 而不是 click）。
  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    window.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  const pick = useCallback(
    (id: string | null) => {
      setOpen(false);
      onMove(id);
    },
    [onMove],
  );

  return (
    <div className={styles.batchBar} ref={wrapRef}>
      <span className={styles.batchCount}>已选 {count} 条</span>

      <div className={styles.batchMoveWrap}>
        <button
          type="button"
          className={styles.batchBtn}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <FolderInput size={12} /> 移动到…
        </button>
        {open && (
          <div className={styles.batchPop} role="menu">
            <button type="button" className={styles.batchPopItem} onClick={() => pick(null)}>
              <Library size={12} /> 未分类
            </button>
            {folders.map((f) => (
              <button
                key={f.id}
                type="button"
                className={styles.batchPopItem}
                onClick={() => pick(f.id)}
              >
                {/* 缩进把层级画出来：平铺的话同名子文件夹根本分不出来 */}
                <span style={{ paddingLeft: (f.depth - 1) * 10 }}>{f.name}</span>
              </button>
            ))}
          </div>
        )}
      </div>

      <button type="button" className={styles.batchBtn} onClick={onDelete}>
        <Trash2 size={12} /> 删除
      </button>

      {/* Esc 也能清（列表那边接的），但得给鼠标用户留一个看得见的出口 */}
      <button
        type="button"
        className={styles.batchClear}
        onClick={onClear}
        title="取消选择（Esc）"
        aria-label="取消选择"
      >
        <X size={12} />
      </button>
    </div>
  );
}
