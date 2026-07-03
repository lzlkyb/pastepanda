import { createContext, useState, useEffect, useCallback, useRef, useMemo, ReactNode } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Copy, ClipboardPaste, Pin, Trash2, ExternalLink, FileCode, Pencil, ChevronRight } from "lucide-react";
import styles from "./ContextMenu.module.css";

export interface MenuItem {
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  danger?: boolean;
  separator?: boolean;
  children?: MenuItem[];
}

interface ContextMenuProps {
  children: ReactNode;
  items: MenuItem[];
}

// ★ React Context 传递 trigger 函数 + 动态菜单项，Card 直接调用，完全不依赖 DOM 事件冒泡
export const CtxMenuCtx = createContext<((x: number, y: number, items: MenuItem[]) => void) | null>(null);

export function ContextMenu({ children }: { children: ReactNode }) {
  const [pos, setPos] = useState<{ x: number; y: number } | null>(null);
  const [items, setItems] = useState<MenuItem[]>([]);
  const menuRef = useRef<HTMLDivElement>(null);
  const [menuSize, setMenuSize] = useState({ width: 0, height: 0 });
  const [activeIndex, setActiveIndex] = useState(-1);
  const [activeSubIndex, setActiveSubIndex] = useState<number | null>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);

  // ★ 暴露给 Card 的 trigger 函数 — 通过 Context 传递
  const trigger = useCallback((x: number, y: number, menuItems: MenuItem[]) => {
    setItems(menuItems);
    setPos({ x, y });
    setActiveIndex(-1);
    setActiveSubIndex(null);
  }, []);

  // 预估算菜单尺寸（在渲染后测量）— 使用 items 的长度作为稳定依赖
  const itemsKey = items.map(i => i.label + (i.children?.length ?? 0)).join("|");
  useEffect(() => {
    if (pos && menuRef.current) {
      const rect = menuRef.current.getBoundingClientRect();
      setMenuSize({ width: rect.width, height: rect.height });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [pos, itemsKey]);

  // 智能翻折：默认右下弹出 → 空间不足时自动翻到左上
  // 使用 useMemo 替代渲染期间 setState，避免 React error #301（无限重渲染）
  const adjustedPos = useMemo(() => {
    if (!pos) return null;
    const menuW = menuSize.width || 180;
    const menuH = menuSize.height || 260;
    const margin = 8;
    const availRight = window.innerWidth - pos.x - margin;
    const availBelow = window.innerHeight - pos.y - margin;
    const availLeft = pos.x - margin;
    const availAbove = pos.y - margin;

    // 水平方向：优先向右，空间不足时向左
    let left = pos.x;
    if (availRight < menuW && availLeft > availRight) {
      left = pos.x - menuW;
    }
    left = Math.max(margin, Math.min(left, window.innerWidth - menuW - margin));

    // 垂直方向：优先向下，空间不足时向上
    let top = pos.y;
    if (availBelow < menuH && availAbove > availBelow) {
      top = pos.y - menuH;
    }
    top = Math.max(margin, Math.min(top, window.innerHeight - menuH - margin));

    // 检测子菜单是否需要翻到左侧（右侧空间 < 子菜单宽 + 间距）
    const submenuWidth = 180;
    const availForSubRight = window.innerWidth - left - menuW - margin;
    const submenuFlip = availForSubRight < submenuWidth + 4;

    return { left, top, submenuFlip };
  }, [pos, menuSize]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    // ★ 如果事件来自 Card 内部（已经有原生监听器通过 ctxTrigger 处理），
    //    就不再重复设置 pos，避免状态冲突导致菜单闪烁/不显示
    const target = e.target as HTMLElement;
    if (target.closest?.(".card")) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    setPos({ x: e.clientX, y: e.clientY });
    setActiveIndex(-1);
    setActiveSubIndex(null);
  }, []);

  // ★ 不再依赖 DOM 事件冒泡。Card 通过 CtxMenuCtx 直接调用 trigger(x, y)。

  // 键盘触发右键菜单 (Shift+F10 / ContextMenu 键)
  const handleKeyDown = useCallback((e: React.KeyboardEvent) => {
    if ((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu") {
      e.preventDefault();
      e.stopPropagation();
      const rect = wrapperRef.current?.getBoundingClientRect();
      setPos({
        x: rect ? rect.left + rect.width / 2 : 100,
        y: rect ? rect.top + rect.height / 2 : 100,
      });
      setActiveIndex(-1);
      setActiveSubIndex(null);
    }
  }, []);

  // 展开的菜单项列表（过滤掉不可点击的分组父项）
  const flatItems = items.filter((item) => item.onClick || item.children);

  // 键盘导航（全局监听，解决焦点不在 wrapper 上的问题）
  useEffect(() => {
    if (!pos) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveSubIndex(null);
        setActiveIndex((i) => Math.min(i + 1, flatItems.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveSubIndex(null);
        setActiveIndex((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (activeSubIndex !== null) {
          // 在子菜单中按 Enter：触发子菜单项
          const parentItem = flatItems[activeIndex];
          if (parentItem?.children?.[activeSubIndex]) {
            parentItem.children[activeSubIndex].onClick?.();
            setPos(null);
          }
        } else if (activeIndex >= 0 && activeIndex < flatItems.length) {
          const item = flatItems[activeIndex];
          if (item.onClick) {
            item.onClick();
            setPos(null);
          } else if (item.children) {
            // 展开子菜单
            setActiveSubIndex(0);
          }
        }
      } else if (e.key === "ArrowRight") {
        e.preventDefault();
        if (activeIndex >= 0 && flatItems[activeIndex]?.children && activeSubIndex === null) {
          setActiveSubIndex(0);
        }
      } else if (e.key === "ArrowLeft") {
        e.preventDefault();
        if (activeSubIndex !== null) {
          setActiveSubIndex(null);
        }
      } else if (e.key === "Escape") {
        if (activeSubIndex !== null) {
          setActiveSubIndex(null);
        } else {
          setPos(null);
        }
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [pos, activeIndex, activeSubIndex, flatItems]);

  useEffect(() => {
    if (!pos) return;
    let skipFirstMousedown = true; // 跳过右键触发的 mousedown 事件
    const close = (e: Event) => {
      if (e.type === "mousedown" && skipFirstMousedown) {
        skipFirstMousedown = false;
        return;
      }
      // 忽略菜单自身区域内的点击/右键
      if (e.target instanceof Node && menuRef.current?.contains(e.target)) return;
      setPos(null);
    };
    // ★ 用 mousedown 代替 click（更早触发，更可靠）
    //    延迟注册 + 跳过首次 mousedown，彻底解决右键菜单闪现消失问题
    const timer = setTimeout(() => {
      window.addEventListener("mousedown", close);
      window.addEventListener("contextmenu", close);
    }, 300);
    return () => {
      clearTimeout(timer);
      window.removeEventListener("mousedown", close);
      window.removeEventListener("contextmenu", close);
    };
  }, [pos]);

  // 获取某 item 在 flatItems 中的索引
  const getFlatIndex = (item: MenuItem) => flatItems.findIndex((f) => f === item);

  return (
    <>
      <CtxMenuCtx.Provider value={trigger}>
        <div ref={wrapperRef} onContextMenu={handleContextMenu} onKeyDown={handleKeyDown} tabIndex={0} role="application" aria-haspopup="menu" aria-label="右键菜单" style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>{children}</div>
      </CtxMenuCtx.Provider>
      {pos && createPortal(
        <AnimatePresence>
          <motion.div
            key="ctx-menu-portal"
            ref={menuRef}
            initial={{ opacity: 1, scale: 1 }}
            animate={{ opacity: 1, scale: 1 }}
            exit={{ opacity: 0 }}
            transition={{ duration: 0 }}
            className={styles.ctxMenu}
            style={{
              position: "fixed",
              left: `${adjustedPos ? adjustedPos.left : pos.x}px`,
              top: `${adjustedPos ? adjustedPos.top : pos.y}px`,
              zIndex: 99999,
              transform: "none",
            }}
            onClick={(e) => e.stopPropagation()}
            onAnimationComplete={() => {
              if (menuRef.current) {
                const rect = menuRef.current.getBoundingClientRect();
                setMenuSize({ width: rect.width, height: rect.height });
              }
            }}
          >
            {items.map((item, i) => {
              const flatIdx = getFlatIndex(item);
              const isActive = flatIdx === activeIndex;

              if (item.children) {
                // 子菜单父项
                return (
                  <div key={i}>
                    {item.separator && i > 0 && <div className={styles.ctxSep} />}
                    <div
                      className={`${styles.ctxItem} ${styles.ctxItemParent}${isActive ? ` ${styles.keyboardActive}` : ""}`}
                      onMouseEnter={() => { setActiveIndex(flatIdx); setActiveSubIndex(null); }}
                      onMouseLeave={() => { if (activeSubIndex === null) setActiveIndex(-1); }}
                    >
                      <span className={styles.ctxItemIcon}>{item.icon}</span>
                      {item.label}
                      <span className={styles.ctxItemArrow}><ChevronRight size={12} /></span>

                      {/* 子菜单弹层（hover 或键盘导航时显示） */}
                      {(isActive || activeSubIndex !== null) && (
                        <div
                          className={`${styles.ctxSubmenu}${adjustedPos?.submenuFlip ? ` ${styles.flipLeft}` : ""}`}
                          onMouseEnter={() => { setActiveIndex(flatIdx); setActiveSubIndex(null); }}
                        >
                          {item.children.map((child, j) => (
                            <button
                              key={j}
                              className={`${styles.ctxItem}${activeSubIndex === j ? ` ${styles.keyboardActive}` : ""}${child.danger ? ` ${styles.danger}` : ""}`}
                              onClick={() => { child.onClick?.(); setPos(null); }}
                              onMouseEnter={() => setActiveSubIndex(j)}
                            >
                              <span className={styles.ctxItemIcon}>{child.icon}</span>
                              {child.label}
                            </button>
                          ))}
                        </div>
                      )}
                    </div>
                  </div>
                );
              }

              return (
                <div key={i}>
                  {item.separator && i > 0 && <div className={styles.ctxSep} />}
                  <button
                    onClick={() => { item.onClick?.(); setPos(null); }}
                    className={`${styles.ctxItem}${item.danger ? ` ${styles.danger}` : ""}${isActive ? ` ${styles.keyboardActive}` : ""}`}
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
        </AnimatePresence>,
        document.body
      )}
    </>
  );
}

/** 根据 item 类型生成不同的变换子菜单项 */
function buildTransformMenu(onTransform: (t: string) => void, itemType?: string, subType?: string): MenuItem[] {
  const children: MenuItem[] = [];

  if (itemType === "text") {
    // 文本通用变换
    children.push(
      { icon: <span className={`${styles.ctxTextIcon} ${styles.ctxTextUpper}`}>A</span>, label: "粘贴为大写", onClick: () => onTransform("upper") },
      { icon: <span className={`${styles.ctxTextIcon} ${styles.ctxTextLower}`}>a</span>, label: "粘贴为小写", onClick: () => onTransform("lower") },
      { icon: <span className={`${styles.ctxTextIcon} ${styles.ctxTextScissor}`}>✂</span>, label: "粘贴并去空白", onClick: () => onTransform("strip") },
      { icon: <span className={`${styles.ctxTextIcon} ${styles.ctxTextPara}`}>¶</span>, label: "粘贴并去空行", onClick: () => onTransform("strip_lines") },
      { icon: <span className={`${styles.ctxTextIcon} ${styles.ctxTextQuote}`}>"</span>, label: "粘贴为引号包裹", onClick: () => onTransform("quote") },
    );

    // 子类型专属变换
    if (subType === "link") {
      children.push(
        { icon: <span style={{ fontSize: 12 }}>🔗</span>, label: "粘贴为 Markdown 链接", onClick: () => onTransform("md_link") },
        { icon: <span style={{ fontSize: 12 }}>🔗</span>, label: "粘贴为纯链接文本", onClick: () => onTransform("plain_url") },
      );
    } else if (subType === "email") {
      children.push(
        { icon: <span style={{ fontSize: 12 }}>📧</span>, label: "粘贴为 mailto 链接", onClick: () => onTransform("mailto") },
      );
    } else if (subType === "code") {
      children.push(
        { icon: <span style={{ fontSize: 12 }}>{`</>`}</span>, label: "粘贴为代码块", onClick: () => onTransform("code_block") },
        { icon: <span style={{ fontSize: 12 }}>≡</span>, label: "粘贴为单行", onClick: () => onTransform("single_line") },
      );
    } else if (subType === "phone") {
      children.push(
        { icon: <span style={{ fontSize: 12 }}>📞</span>, label: "粘贴为 tel 链接", onClick: () => onTransform("tel") },
        { icon: <span style={{ fontSize: 12 }}>+</span>, label: "粘贴为 +86 格式", onClick: () => onTransform("phone_cn") },
      );
    } else {
      // 普通文本：也有 Markdown 链接
      children.push(
        { icon: <span style={{ fontSize: 12 }}>🔗</span>, label: "粘贴为 Markdown 链接", onClick: () => onTransform("md_link") },
      );
    }
  } else if (itemType === "image") {
    children.push(
      { icon: <span style={{ fontSize: 12 }}>🖼</span>, label: "粘贴为 Markdown 图片", onClick: () => onTransform("md_image") },
      { icon: <span style={{ fontSize: 12 }}>📋</span>, label: "粘贴为 Base64", onClick: () => onTransform("img_base64") },
    );
  } else if (itemType === "file") {
    children.push(
      { icon: <span style={{ fontSize: 12 }}>📄</span>, label: "粘贴为文件名", onClick: () => onTransform("file_name") },
      { icon: <span style={{ fontSize: 12 }}>📁</span>, label: "粘贴为目录路径", onClick: () => onTransform("file_dir") },
      { icon: <span style={{ fontSize: 12 }}>\\</span>, label: "粘贴为反斜杠路径", onClick: () => onTransform("file_bslash") },
      { icon: <span style={{ fontSize: 12 }}>/</span>, label: "粘贴为正斜杠路径", onClick: () => onTransform("file_fslash") },
      { icon: <span style={{ fontSize: 12 }}>📋</span>, label: "粘贴为文件列表", onClick: () => onTransform("file_list") },
    );
  }

  return children;
}

// Helper to create standard card context menu items
export function createCardMenuItems(opts: {
  onCopy: () => void;
  onPaste: () => void;
  onPin: () => void;
  onDelete: () => void;
  onEdit?: () => void;
  onAddSnippet?: () => void;
  onOpenUrl?: () => void;
  onPasteTransform?: (transform: string) => void;
  pinned?: boolean;
  hasUrl?: boolean;
  /** item 基础类型 + 子类型，用于按类型生成不同变换菜单 */
  itemType?: string;
  itemSubType?: string;
}): MenuItem[] {
  const items: MenuItem[] = [];

  // 编辑入口（文本类型优先显示）
  if (opts.onEdit) {
    items.push({ icon: <Pencil size={14} />, label: "编辑内容", onClick: opts.onEdit });
  }

  items.push(
    { icon: <Copy size={14} />, label: "复制到剪贴板", onClick: opts.onCopy },
    { icon: <ClipboardPaste size={14} />, label: "粘贴到前台", onClick: opts.onPaste },
  );

  // 粘贴变换折叠为子菜单（按类型定制）
  if (opts.onPasteTransform) {
    const transformChildren: MenuItem[] = buildTransformMenu(opts.onPasteTransform, opts.itemType, opts.itemSubType);
    if (transformChildren.length > 0) {
      items.push({
        icon: <ClipboardPaste size={14} />,
        label: "粘贴并变换",
        children: transformChildren,
      });
    }
  }

  if (opts.hasUrl && opts.onOpenUrl) {
    items.push({ icon: <ExternalLink size={14} />, label: "在浏览器中打开", onClick: opts.onOpenUrl });
  }

  items.push(
    { icon: <Pin size={14} />, label: opts.pinned ? "取消置顶" : "置顶", onClick: opts.onPin, separator: true },
  );

  if (opts.onAddSnippet) {
    items.push({ icon: <FileCode size={14} />, label: "添加到片段库", onClick: opts.onAddSnippet });
  }

  items.push(
    { icon: <Trash2 size={14} />, label: "删除", onClick: opts.onDelete, danger: true, separator: true },
  );

  return items;
}
