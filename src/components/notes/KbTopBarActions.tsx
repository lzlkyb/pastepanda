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
   * 弹溢出菜单：从按钮下方展开、与按钮**右缘对齐**。
   *
   * 🔴 一定要传 `alignRight`，并且传的是 `r.right`（不是 `r.left`）。
   * 之前传按钮左缘、指望 `useMenuPosition` 的贴边翻折去“碰巧”，
   * 而那两条分支没一条是对的：
   * ・右侧空间够 ⇒ 菜单从按钮左缘往右铺，穿到设置/窗口按钮底下；
   * ・右侧空间不够 ⇒ 翻成「菜单右缘贴按钮**左**缘」，与按钮错开一个按钮宽。
   * 而这个按钮就在顶栏右上角，两种情形都碰得到。
   */
  const openMore = () => {
    if (!ctxTrigger) return;
    const r = btnRef.current?.getBoundingClientRect();
    if (!r) return;
    ctxTrigger(r.right, r.bottom + 2, moreItems, { alignRight: true });
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
