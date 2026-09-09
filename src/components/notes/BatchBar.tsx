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
import { useCallback, useRef, useState } from "react";
import { FolderInput, Library, Trash2, X } from "lucide-react";
import type { NoteFolder } from "@/lib/api";
import styles from "../KnowledgeView.module.css";
import { useClickOutside } from "@/hooks/useClickOutside";
import { useDialogEscape } from "@/hooks/useDialogEscape";

export function BatchBar({
  count,
  folders,
  onMove,
  onDelete,
  onClear,
  busy,
}: {
  /** 已选条数。为 0 时调用方不渲染本组件。 */
  count: number;
  folders: NoteFolder[];
  /** `null` = 移回未分类。 */
  onMove: (folderId: string | null) => void;
  onDelete: () => void;
  onClear: () => void;
  /**
   * 正在跑的批量动作。null = 不忙。
   *
   * 🔴 两个作用：① U1 的进度指示（串行循环跑 50 条时界面不能一动不动）；
   * ② 把按钮禁掉防重入——循环没跑完再点一次删除，第二轮会打在已软删的
   * 行上全失败，用户看到「已删除 0 条，12 条失败」这种自己造的假失败。
   */
  busy?: { done: number; total: number; verb: string } | null;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  // 点外面 / Esc 关下拉。跟 `ViewControls` 同一套做法——现在真的是同一套了：
  // 两边都调公共 hook，而不是各写一遍（规则 #11）。
  const closeMenu = useCallback(() => setOpen(false), []);
  useClickOutside(wrapRef, closeMenu, open);
  useDialogEscape(closeMenu, open);

  const pick = useCallback(
    (id: string | null) => {
      setOpen(false);
      onMove(id);
    },
    [onMove],
  );

  return (
    <div className={styles.batchBar} ref={wrapRef}>
      {/* 忙的时候把进度顶到计数位：那是本条上唯一一直在看的位置。 */}
      <span className={styles.batchCount}>
        {busy ? `${busy.verb}中 ${busy.done}/${busy.total}` : `已选 ${count} 条`}
      </span>
      {/* 进度只写在文字里，读屏用户听不到（SC 4.1.3）。 */}
      <span className="sr-only" role="status">
        {busy ? `正在${busy.verb}第 ${busy.done} 条，共 ${busy.total} 条` : ""}
      </span>

      <div className={styles.batchMoveWrap}>
        <button
          type="button"
          className={styles.batchBtn}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
          disabled={!!busy}
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

      <button type="button" className={styles.batchBtn} onClick={onDelete} disabled={!!busy}>
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
