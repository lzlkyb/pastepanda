/**
 * 主窗口右键菜单的**容器**：开合状态、焦点、渲染。
 *
 * 内容（有哪些菜单项）在 contextMenu/cardMenuItems.tsx；定位在 useMenuPosition；
 * 键盘/关闭/热键在 useMenuInteractions。这么拆是因为这个文件曾到 809 行，
 * 破了 claude.md §7 的 300 行上限，而"菜单摆什么"和"菜单怎么弹"本来就是两件事。
 *
 * 对外 API 保持不动（MenuItem / CtxMenuCtx / ContextMenu / createCardMenuItems
 * 仍从这里导出），调用方不需要改 import。
 */

import { createContext, useState, useEffect, useCallback, useRef, useMemo, useId, Fragment, ReactNode } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { ChevronRight } from "lucide-react";
import { flattenNavigable, type MenuItem } from "./contextMenu/menuModel";
import { useMenuPosition } from "./contextMenu/useMenuPosition";
import { useMenuKeyboard, useMenuDismiss, useContextMenuHotkey } from "./contextMenu/useMenuInteractions";
import styles from "./ContextMenu.module.css";

export type { MenuItem };
export { createCardMenuItems } from "./contextMenu/cardMenuItems";

// ★ React Context 传递 trigger 函数 + 动态菜单项，Card 直接调用，完全不依赖 DOM 事件冒泡
export const CtxMenuCtx = createContext<((x: number, y: number, items: MenuItem[]) => void) | null>(null);

export function ContextMenu({ children }: { children: ReactNode }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [items, setItems] = useState<MenuItem[]>([]);
  /** 菜单项 DOM id 的前缀（aria-activedescendant 需要真实 id 才能指向高亮项） */
  const domIdBase = useId();

  /** 菜单是否真的显示出来了。
   *
   *  必须收口成这一个判据：pos 有值不等于菜单可见 —— Card 那边是
   *  `ctxTrigger(x, y, menuItems || [])`，兜底能传进空数组，那时容器一个菜单项都没有，
   *  不该挂出一个空玻璃方块。而只要判据分了两套，就会出现「键盘全被菜单吞掉（因为
   *  按 pos 广播了 app-ctxmenu-open，App.handleKeyDown 整个让位）但屏幕上没有菜单」
   *  这种没法退出的状态。渲染、开合广播、键盘、关闭监听全部认这一个 open。 */
  const open = !!pos && items.length > 0;

  const closeMenu = useCallback(() => setPos(null), []);

  /** 可被键盘落上的顶层项。memo 住是因为它进了键盘 effect 的依赖表，
   *  每次渲染都造新数组的话监听器会跟着每次渲染卸一次挂一次。 */
  const flatItems = useMemo(() => flattenNavigable(items), [items]);

  const { activeIndex, activeSubIndex, setActiveIndex, setActiveSubIndex, resetActive } =
    useMenuKeyboard({ open, flatItems, onClose: closeMenu });

  const { menuRef, submenuRef, adjustedPos } = useMenuPosition({ open, pos, items, activeIndex });

  useMenuDismiss({ open, menuRef, onClose: closeMenu });
  useContextMenuHotkey();

  // ★ 暴露给 Card 的 trigger 函数 — 通过 Context 传递
  const trigger = useCallback((x: number, y: number, menuItems: MenuItem[]) => {
    setItems(menuItems);
    setPos({ x, y });
    resetActive();
  }, [resetActive]);

  // U3：菜单开关状态广播给全局键盘层（App.handleKeyDown 据此让位，避免按键双重处理）
  useEffect(() => {
    if (!open) return;
    window.dispatchEvent(new CustomEvent("app-ctxmenu-open"));
    return () => { window.dispatchEvent(new CustomEvent("app-ctxmenu-close")); };
  }, [open]);

  // 焦点：打开时移进菜单，关闭时还回原处。
  // 键盘处理本身挂在 window 上、不依赖焦点，但读屏要靠焦点才会播报"菜单，共 N 项"，
  // aria-activedescendant 也只有在菜单持有焦点时才有意义。
  const restoreFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    if (!open) return;
    restoreFocusRef.current = document.activeElement as HTMLElement | null;
    menuRef.current?.focus();
    return () => {
      const prev = restoreFocusRef.current;
      restoreFocusRef.current = null;
      // 条目被「删除」后原节点已经不在文档里，还焦会静默落到 body —— 判一下再还
      if (prev?.isConnected) prev.focus();
    };
  }, [open, menuRef]);

  // 卡片自己挂了原生 contextmenu 监听并 stopImmediatePropagation（Card.tsx），所以能冒泡到
  // 这里的都是**卡片之外**的地方：列表下方空白、列表为空时的整片区域、虚拟行内的间隙。
  // 这里只挡掉 webview 的原生菜单，**不弹自己的菜单**。
  //
  // 以前这里会 setPos 却不 setItems，而 items 只在 trigger 里赋值、关闭时也不清空，
  // 于是右键空白处会把**上一次那张卡片**的菜单整份弹回来 —— 点「删除」删掉的是用户
  // 根本没在上面右键的那张卡（已实测复现）；一次都没右键过时 items 是 []，
  // 则挂出一个没有任何菜单项的空玻璃方块。现在 items 只剩 trigger 一个来源。
  //
  // 注意不能 stopPropagation：菜单开着时右键空白处要能把它关掉，
  // 而那是靠 useMenuDismiss 里 window 上的 contextmenu 监听做的，拦了就关不掉了。
  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
  }, []);

  const getFlatIndex = (item: MenuItem) => flatItems.findIndex((f) => f === item);

  // 菜单项的 DOM id —— aria-activedescendant 要靠它指向"当前高亮的那一项"。
  // 顶层用 flatIdx（与 activeIndex 同一套编号），子项用 children 里的真实下标（与 activeSubIndex 同套）。
  const itemDomId = (flatIdx: number) => `${domIdBase}-item-${flatIdx}`;
  const subDomId = (flatIdx: number, childIdx: number) => `${domIdBase}-sub-${flatIdx}-${childIdx}`;

  return (
    <>
      <CtxMenuCtx.Provider value={trigger}>
        {/* 这一层只是布局容器 + 挡掉空白处的原生右键菜单。
            以前挂了 role="application"，会让屏幕阅读器对**整个列表区**进入应用模式，
            把里面 role="listbox" 的记录列表语义盖掉；菜单语义属于下面那个 portal。 */}
        <div onContextMenu={handleContextMenu} style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>{children}</div>
      </CtxMenuCtx.Provider>
      {/* ★ 退出动画修复：open 条件移入 portal 内的 AnimatePresence ——
          否则 {open && createPortal(...)} 在关闭时整个 portal 瞬间卸载，exit 动画无法播放 */}
      {createPortal(
        <AnimatePresence>
          {open && (
          <motion.div
            key="ctx-menu-portal"
            ref={menuRef}
            role="menu"
            aria-label="条目操作"
            tabIndex={-1}
            aria-activedescendant={
              activeSubIndex === null && activeIndex >= 0 ? itemDomId(activeIndex) : undefined
            }
            initial={{ opacity: 0, scale: 0.95, y: -4 }}
            animate={{ opacity: 1, scale: 1, y: 0 }}
            exit={{ opacity: 0, scale: 0.95, y: -4 }}
            transition={{ type: "spring", stiffness: 500, damping: 35 }}
            className={styles.ctxMenu}
            style={{
              position: "fixed",
              left: `${adjustedPos ? adjustedPos.left : pos.x}px`,
              top: `${adjustedPos ? adjustedPos.top : pos.y}px`,
              transform: "none",
            }}
            onClick={(e) => e.stopPropagation()}
          >
            {items.map((item, i) => {
              const flatIdx = getFlatIndex(item);
              const isActive = flatIdx === activeIndex;

              if (item.children) {
                // 子菜单父项
                return (
                  <div key={i}>
                    {item.separator && i > 0 && <div className={styles.ctxSep} role="separator" />}
                    <div
                      id={itemDomId(flatIdx)}
                      role="menuitem"
                      // 展开时子菜单整片文字都在这个 div 里，不给显式名字的话读屏会把
                      // 所有子项念成父项的名字
                      aria-label={item.label}
                      aria-haspopup="menu"
                      aria-expanded={isActive}
                      className={`${styles.ctxItem} ${styles.ctxItemParent}${isActive ? ` ${styles.keyboardActive}` : ""}`}
                      onMouseEnter={() => { setActiveIndex(flatIdx); setActiveSubIndex(null); }}
                      onMouseLeave={() => { if (activeSubIndex === null) setActiveIndex(-1); }}
                    >
                      <span className={styles.ctxItemIcon}>{item.icon}</span>
                      {item.label}
                      <span className={styles.ctxItemArrow}><ChevronRight size={12} /></span>

                      {/* 子菜单弹层（仅当该父项激活时显示 —— activeSubIndex 是全局状态，
                          不能用它门控，否则多个子菜单会同时弹出互相叠加） */}
                      {/* 子菜单退场：AnimatePresence 在 isActive 置 false 时短暂保留播放淡出。
                          入场仍由 CSS ctxSubmenuIn 负责（与 flipLeft 翻转方向耦合、经 classList
                          命令式控制），framer 仅承担退场，避免 transform 冲突 */}
                      <AnimatePresence>
                      {isActive && (
                        <motion.div
                          ref={submenuRef}
                          role="menu"
                          aria-label={item.label}
                          aria-activedescendant={
                            activeSubIndex !== null ? subDomId(flatIdx, activeSubIndex) : undefined
                          }
                          className={styles.ctxSubmenu}
                          exit={{ opacity: 0, transition: { duration: 0.12, ease: "easeIn" } }}
                          onMouseEnter={() => { setActiveIndex(flatIdx); setActiveSubIndex(null); }}
                        >
                          {item.children.map((child, j) => (
                            <Fragment key={j}>
                              {child.separator && j > 0 && <div className={styles.ctxSep} role="separator" />}
                              <button
                                id={subDomId(flatIdx, j)}
                                role="menuitem"
                                className={`${styles.ctxItem}${activeSubIndex === j ? ` ${styles.keyboardActive}` : ""}${child.danger ? ` ${styles.danger}` : ""}`}
                                onClick={() => { child.onClick?.(); closeMenu(); }}
                                onMouseEnter={() => setActiveSubIndex(j)}
                              >
                                <span className={styles.ctxItemIcon}>{child.icon}</span>
                                {child.label}
                              </button>
                            </Fragment>
                          ))}
                        </motion.div>
                      )}
                      </AnimatePresence>
                    </div>
                  </div>
                );
              }

              return (
                <div key={i}>
                  {item.separator && i > 0 && <div className={styles.ctxSep} role="separator" />}
                  <button
                    id={itemDomId(flatIdx)}
                    role="menuitem"
                    onClick={() => { item.onClick?.(); closeMenu(); }}
                    className={`${styles.ctxItem}${item.primary ? ` ${styles.ctxItemPrimary}` : ""}${item.danger ? ` ${styles.danger}` : ""}${isActive ? ` ${styles.keyboardActive}` : ""}`}
                    onMouseEnter={() => setActiveIndex(flatIdx)}
                    onMouseLeave={() => { if (activeSubIndex === null) setActiveIndex(-1); }}
                  >
                    <span className={styles.ctxItemIcon}>{item.icon}</span>
                    {item.label}
                  </button>
                </div>
              );
            })}
          </motion.div>
          )}
        </AnimatePresence>,
        document.body
      )}
    </>
  );
}
