/**
 * KbTopBarActions.tsx —— 知识模式在顶栏「模式专属段」里的按钮（目前只有「⋯ 更多」）。
 *
 * ❗ 本组件由 `KnowledgeView` 用 `createPortal` 投到顶栏插槽里，**不能**直接写进 `TopBar`：
 *   菜单靠 `CtxMenuCtx`，而那个 Provider 在 `KnowledgeView` 内部，`TopBar` 是它的兄弟节点、
 *   在 Provider 外面，`useContext` 在那里拿不到东西。详见 `@/lib/topbarSlot`。
 *
 * 为何只搬了「⋯」，没搬「＋新建」（改之前先读）：
 * - 「⋯」里是导入 / 导出 / 连接 AI 工具 / 回收站——全是对**整个知识库**做的事，
 *   与当前在哪个文件夹无关，所以它属于顶栏；
 * - 「＋新建」是对**当前文件夹**做的事，它的提示写着「落入「…」」，而那个文件夹名
 *   就是旁边的面包屑。挪到顶栏等于切断它唯一的落点线索，所以留在 `KnowledgeToolbar`。
 *
 * 样式复用 `TopBar.module.css` 的 `.iconBtn`：它就是顶栏那一排按钮的样式，
 * 另开一份只会让同一排按钮的样式散在两个文件里（同规则 #11 收口）。
 */
import { useContext, useRef } from "react";
import { MoreHorizontal } from "lucide-react";
import { CtxMenuCtx, type MenuItem } from "@/components/ContextMenu";
import styles from "@/components/TopBar.module.css";

export function KbTopBarActions({ moreItems }: { moreItems: MenuItem[] }) {
  const ctxTrigger = useContext(CtxMenuCtx);
  const btnRef = useRef<HTMLButtonElement | null>(null);

  /**
   * 弹溢出菜单。坐标取按钮左下角，菜单从按钮下方展开（同普通下拉的位置感）。
   * 按钮靠窗口右缘也不用自己算右对齐：`useMenuPosition` 会按实测宽度翻折并钳制到视口内。
   */
  const openMore = () => {
    if (!ctxTrigger) return;
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    ctxTrigger(r.left, r.bottom + 2, moreItems);
  };

  return (
    <button
      type="button"
      ref={btnRef}
      className={styles.iconBtn}
      data-hue="sky"
      onClick={openMore}
      title="导入 / 导出 / 连接 AI 工具 / 回收站"
      aria-label="知识库更多操作"
    >
      <MoreHorizontal className={styles.iconSvg} />
    </button>
  );
}
