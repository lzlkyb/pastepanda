import { createContext, useState, useEffect, useLayoutEffect, useCallback, useRef, useMemo, Fragment, ReactNode } from "react";
import { createPortal } from "react-dom";
import { motion, AnimatePresence } from "framer-motion";
import { Copy, ClipboardPaste, Pin, Trash2, ExternalLink, FileCode, Pencil, ChevronRight, Tag, FolderInput, FolderOpen, FileText, Sparkles, Image as ImageIcon, Palette, MoreHorizontal, Regex } from "lucide-react";
import { getEnabledRules } from "@/lib/regexRules";
import { isCodeLike } from "@/lib/contentTypes";
import { useAppStore } from "@/stores/appStore";
import styles from "./ContextMenu.module.css";

export interface MenuItem {
  icon: ReactNode;
  label: string;
  onClick?: () => void;
  danger?: boolean;
  separator?: boolean;
  /** 分组标题（非交互，不可点击） */
  header?: boolean;
  /** 类型主操作（置顶高亮显示） */
  primary?: boolean;
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

  // U3：菜单开关状态广播给全局键盘层（App.handleKeyDown 据此让位，避免按键双重处理）
  useEffect(() => {
    if (!pos) return;
    window.dispatchEvent(new CustomEvent("app-ctxmenu-open"));
    return () => { window.dispatchEvent(new CustomEvent("app-ctxmenu-close")); };
  }, [pos]);

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

    return { left, top };
  }, [pos, menuSize]);

  // 子菜单边缘钳制：打开瞬间（挂载后、绘制前）测量真实宽高与父项视口位置——
  //   水平：按实测宽度决定向右还是向左翻转（替代写死 180 的估算）；
  //   垂直：默认锚在父项上缘 -4px，超出底边时整体上移，比可用视口还高时顶部钳制 + 内部滚动。
  // 仅当前激活父项的子菜单会挂载，submenuRef 即指向它。
  const submenuRef = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const sub = submenuRef.current;
    if (!sub) return;
    const parent = sub.parentElement as HTMLElement | null;
    if (!parent) return;
    const parentRect = parent.getBoundingClientRect();
    const margin = 8;
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    // 先清掉上一次的行内调整再测量自然尺寸，避免 maxHeight 钳制形成反馈
    sub.style.top = "";
    sub.style.maxHeight = "";
    sub.style.overflowY = "";
    sub.classList.remove(styles.flipLeft);

    const subW = sub.offsetWidth;
    const subH = sub.offsetHeight;

    // 水平：优先向右，放不下且左侧放得下时翻到左侧
    const fitsRight = parentRect.right + 4 + subW <= vw - margin;
    const fitsLeft = parentRect.left - 4 - subW >= margin;
    sub.classList.toggle(styles.flipLeft, !fitsRight && fitsLeft);

    // 垂直：超出底边上移；上移后顶到上缘仍放不下，则顶部钳制 + 限高滚动
    let topOffset = -4;
    const naturalBottom = parentRect.top + topOffset + subH;
    if (naturalBottom > vh - margin) {
      topOffset -= naturalBottom - (vh - margin);
      if (parentRect.top + topOffset < margin) {
        topOffset = margin - parentRect.top;
        sub.style.maxHeight = `${vh - 2 * margin}px`;
        sub.style.overflowY = "auto";
      }
    }
    sub.style.top = `${topOffset}px`;
  }, [activeIndex, pos, items]);

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    // ★ 如果事件来自 Card 内部（已经有原生监听器通过 ctxTrigger 处理），
    //    就不再重复设置 pos，避免状态冲突导致菜单闪烁/不显示
    //    注意：CSS Module 会哈希类名，".card" 永不命中；行包装器带 data-item-id（Low 修复）
    const target = e.target as HTMLElement;
    if (target.closest?.("[data-item-id]")) {
      return;
    }
    e.preventDefault();
    e.stopPropagation();
    setPos({ x: e.clientX, y: e.clientY });
    setActiveIndex(-1);
    setActiveSubIndex(null);
  }, []);

  // ★ 不再依赖 DOM 事件冒泡。Card 通过 CtxMenuCtx 直接调用 trigger(x, y)。

  // U40：键盘触发右键菜单 (Shift+F10 / ContextMenu 键) — 改为全局监听，
  // 并在"当前聚焦/选中的卡片"处弹出（而非列表区中心），复用卡片自身的
  // contextmenu 监听器以带上正确的菜单项；同时移除无意义的 wrapper tabIndex
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (!((e.key === "F10" && e.shiftKey) || e.key === "ContextMenu")) return;
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
      e.preventDefault();
      // 定位目标卡片：优先键盘焦点项，其次首个选中项
      const store = useAppStore.getState();
      const targetId = store.focusId || (store.selectedIds.size > 0 ? [...store.selectedIds][0] : null);
      const cardEl = targetId
        ? document.querySelector(`[data-item-id="${targetId}"] [role="option"]`)
        : null;
      if (cardEl) {
        const rect = cardEl.getBoundingClientRect();
        // 在卡片上派发原生 contextmenu 事件 → 卡片监听器以正确坐标 + 菜单项打开
        cardEl.dispatchEvent(new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: rect.left + Math.min(48, rect.width / 3),
          clientY: rect.top + rect.height / 2,
        }));
      } else {
        // 无聚焦卡片时回退到列表区中心
        const wrap = wrapperRef.current?.getBoundingClientRect();
        setPos({
          x: wrap ? wrap.left + wrap.width / 2 : 100,
          y: wrap ? wrap.top + wrap.height / 2 : 100,
        });
        setActiveIndex(-1);
        setActiveSubIndex(null);
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
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
    const close = (e: Event) => {
      // 忽略菜单自身区域内的点击/右键
      if (e.target instanceof Node && menuRef.current?.contains(e.target)) return;
      setPos(null);
    };
    // ★ 用 mousedown 代替 click（更早触发，更可靠）
    //    用 requestAnimationFrame 而不是固定的 300ms 延时来注册监听器：
    //    打开菜单的那次原生 mousedown/contextmenu 事件在本次调用栈内已经
    //    完整派发完毕（JS 单线程，捕获/冒泡阶段必须先跑完；useEffect 本身
    //    也只会在该调用栈结束之后才异步执行），所以哪怕下一帧就注册监听器，
    //    也不可能收到"打开菜单"的那个事件——不需要用固定延时窗口或跳过
    //    首次事件这种脆弱的兜底方案，那样反而会把 300ms 内 / 恰好排在
    //    "第一次"的真实关闭点击也一起吞掉，导致用户要多点一次才能关闭菜单。
    const raf = requestAnimationFrame(() => {
      window.addEventListener("mousedown", close);
      window.addEventListener("contextmenu", close);
    });
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("mousedown", close);
      window.removeEventListener("contextmenu", close);
    };
  }, [pos]);

  // 获取某 item 在 flatItems 中的索引
  const getFlatIndex = (item: MenuItem) => flatItems.findIndex((f) => f === item);

  return (
    <>
      <CtxMenuCtx.Provider value={trigger}>
        <div ref={wrapperRef} onContextMenu={handleContextMenu} role="application" aria-haspopup="menu" aria-label="右键菜单" style={{ flex: 1, minWidth: 0, display: "flex", flexDirection: "column", overflow: "hidden" }}>{children}</div>
      </CtxMenuCtx.Provider>
      {/* ★ 退出动画修复：pos 条件移入 portal 内的 AnimatePresence ——
          否则 {pos && createPortal(...)} 在 pos 置 null 时整个 portal 瞬间卸载，exit 动画无法播放 */}
      {createPortal(
        <AnimatePresence>
          {pos && (
          <motion.div
            key="ctx-menu-portal"
            ref={menuRef}
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

                      {/* 子菜单弹层（仅当该父项激活时显示 —— activeSubIndex 是全局状态，
                          不能用它门控，否则多个子菜单会同时弹出互相叠加） */}
                      {/* 子菜单退场：AnimatePresence 在 isActive 置 false 时短暂保留播放淡出。
                          入场仍由 CSS ctxSubmenuIn 负责（与 flipLeft 翻转方向耦合、经 classList
                          命令式控制），framer 仅承担退场，避免 transform 冲突 */}
                      <AnimatePresence>
                      {isActive && (
                        <motion.div
                          ref={submenuRef}
                          className={styles.ctxSubmenu}
                          exit={{ opacity: 0, transition: { duration: 0.12, ease: "easeIn" } }}
                          onMouseEnter={() => { setActiveIndex(flatIdx); setActiveSubIndex(null); }}
                        >
                          {item.children.map((child, j) => (
                            child.header ? (
                              <div key={j} className={styles.ctxSubHeader} aria-hidden="true">
                                <span className={styles.ctxItemIcon}>{child.icon}</span>
                                {child.label}
                              </div>
                            ) : (
                              <Fragment key={j}>
                                {child.separator && j > 0 && <div className={styles.ctxSep} />}
                                <button
                                  className={`${styles.ctxItem}${activeSubIndex === j ? ` ${styles.keyboardActive}` : ""}${child.danger ? ` ${styles.danger}` : ""}`}
                                  onClick={() => { child.onClick?.(); setPos(null); }}
                                  onMouseEnter={() => setActiveSubIndex(j)}
                                >
                                  <span className={styles.ctxItemIcon}>{child.icon}</span>
                                  {child.label}
                                </button>
                              </Fragment>
                            )
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
                  {item.separator && i > 0 && <div className={styles.ctxSep} />}
                  <button
                    onClick={() => { item.onClick?.(); setPos(null); }}
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

/** 根据 item 类型生成不同的变换子菜单项 */
function buildTransformMenu(onTransform: (t: string) => void, itemType?: string, subType?: string): MenuItem[] {
  const children: MenuItem[] = [];

  if (itemType === "text") {
    // 子类型专属快捷变换（通用变换已迁入注册表，由「更多变换…」进枢纽）
    if (subType === "link") {
      children.push(
        { icon: <span style={{ fontSize: 12 }}>🔗</span>, label: "粘贴为 Markdown 链接", onClick: () => onTransform("md_link") },
        { icon: <span style={{ fontSize: 12 }}>🔗</span>, label: "粘贴为纯链接文本", onClick: () => onTransform("plain_url") },
      );
    } else if (subType === "email") {
      children.push(
        { icon: <span style={{ fontSize: 12 }}>📧</span>, label: "粘贴为 mailto 链接", onClick: () => onTransform("mailto") },
      );
    } else if (isCodeLike(subType)) {
      children.push(
        { icon: <span style={{ fontSize: 12 }}>{`</>`}</span>, label: "粘贴为代码块", onClick: () => onTransform("code_block") },
        { icon: <span style={{ fontSize: 12 }}>≡</span>, label: "粘贴为单行", onClick: () => onTransform("single_line") },
      );
    } else if (subType === "phone") {
      children.push(
        { icon: <span style={{ fontSize: 12 }}>📞</span>, label: "粘贴为 tel 链接", onClick: () => onTransform("tel") },
        { icon: <span style={{ fontSize: 12 }}>+</span>, label: "粘贴为 +86 格式", onClick: () => onTransform("phone_cn") },
      );
    } else if (subType === "color") {
      children.push(
        { icon: <span className={styles.ctxTextIcon} style={{ background: "rgba(255,87,51,.15)", color: "#FF5733" }}>#</span>, label: "复制为 HEX", onClick: () => onTransform("color_hex") },
        { icon: <span className={styles.ctxTextIcon} style={{ background: "rgba(59,130,246,.15)", color: "#3B82F6" }}>R</span>, label: "复制为 RGB", onClick: () => onTransform("color_rgb") },
        { icon: <span className={styles.ctxTextIcon} style={{ background: "rgba(16,185,129,.15)", color: "#10B981" }}>H</span>, label: "复制为 HSL", onClick: () => onTransform("color_hsl") },
      );
    } else if (subType === "file_path") {
      children.push(
        { icon: <span style={{ fontSize: 12 }}>\\</span>, label: "粘贴为反斜杠路径", onClick: () => onTransform("path_bslash") },
        { icon: <span style={{ fontSize: 12 }}>/</span>, label: "粘贴为正斜杠路径", onClick: () => onTransform("path_fslash") },
        { icon: <span style={{ fontSize: 12 }}>📄</span>, label: "粘贴为文件名", onClick: () => onTransform("path_name") },
      );
    } else if (subType === "markdown") {
      children.push(
        { icon: <span style={{ fontSize: 12 }}>{`</>`}</span>, label: "粘贴为代码块", onClick: () => onTransform("code_block") },
        { icon: <span style={{ fontSize: 12 }}>🔗</span>, label: "粘贴为 Markdown 链接", onClick: () => onTransform("md_link") },
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
  onEditTags?: () => void;
  onMoveToGroup?: () => void;
  onAddSnippet?: () => void;
  onOpenUrl?: () => void;
  /** file_path 卡片：用默认应用打开（后端 open_file_with_system） */
  onOpenFile?: () => void;
  /** file_path 卡片：在资源管理器中显示（后端 open_file_location） */
  onRevealFile?: () => void;
  onPasteTransform?: (transform: string) => void;
  /** 打开变换枢纽：列出当前内容可用的所有变换（SQL IN / INSERT / …） */
  onOpenHub?: () => void;
  onConfirmAutoTags?: () => void;
  onRemoveAutoTags?: () => void;
  onMarkdownPreview?: () => void;
  onQrCode?: () => void;
  pinned?: boolean;
  hasUrl?: boolean;
  /** file_path 子类型卡片（显示"用默认应用打开 / 在资源管理器中显示"） */
  isFilePath?: boolean;
  hasAutoTags?: boolean;
  isMarkdown?: boolean;
  canQrCode?: boolean;
  onRegexPreview?: (ruleId: string) => void;
  onManageRegexRules?: () => void;
  /** item 基础类型 + 子类型，用于按类型生成不同变换菜单 */
  itemType?: string;
  itemSubType?: string;
}): MenuItem[] {
  const items: MenuItem[] = [];

  // ① 类型主操作（置顶高亮）——按条目类型挑选最具代表性的动作
  const primary = getPrimaryAction(opts);
  if (primary) {
    items.push({ ...primary.item, primary: true });
  }

  // ② 核心剪贴板操作
  items.push(
    { icon: <Copy size={14} />, label: "复制到剪贴板", onClick: opts.onCopy },
    { icon: <ClipboardPaste size={14} />, label: "粘贴到前台", onClick: opts.onPaste },
  );

  // 粘贴变换折叠为子菜单：子类型快捷项 + 「更多变换…」（枢纽兜底）
  if (opts.onPasteTransform) {
    const transformChildren: MenuItem[] = buildTransformMenu(opts.onPasteTransform, opts.itemType, opts.itemSubType);

    // 「更多变换…」— 打开变换枢纽，长尾通用变换全部收纳于此（仅 text 类型）
    if (opts.onOpenHub && opts.itemType === "text") {
      transformChildren.push({
        icon: <Sparkles size={14} />,
        label: "更多变换…",
        onClick: opts.onOpenHub,
        separator: transformChildren.length > 0,
      });
    }

    if (transformChildren.length > 0) {
      items.push({
        icon: <ClipboardPaste size={14} />,
        label: "粘贴并变换",
        children: transformChildren,
      });
    }
  }

  // 正则替换：独立顶层子菜单（规则列表 + 管理入口）
  if (opts.onRegexPreview && opts.itemType === "text") {
    const regexChildren: MenuItem[] = [];
    const enabledRules = getEnabledRules();
    for (const rule of enabledRules) {
      regexChildren.push({
        icon: <span style={{ fontSize: 12 }}>{rule.preset ? "🔤" : "🏷"}</span>,
        label: rule.name,
        onClick: () => opts.onRegexPreview!(rule.id),
      });
    }
    if (opts.onManageRegexRules) {
      regexChildren.push({
        icon: <span style={{ fontSize: 12 }}>⚙</span>,
        label: "管理正则规则…",
        onClick: opts.onManageRegexRules,
        separator: regexChildren.length > 0,
      });
    }
    if (regexChildren.length > 0) {
      items.push({ icon: <Regex size={14} />, label: "正则替换", children: regexChildren });
    }
  }

  // ③ 类型工具（次级的类型相关操作，排除已作为主操作的项）
  const tools = getTypeTools(opts, primary?.key ?? null);
  tools.forEach((t, idx) => {
    items.push(idx === 0 ? { ...t, separator: true } : t);
  });

  // ④ 更多操作（标签/分组/置顶/片段库等管理项统一收纳）
  const moreChildren = getMoreChildren(opts);
  if (moreChildren.length > 0) {
    items.push({ icon: <MoreHorizontal size={14} />, label: "更多操作", children: moreChildren, separator: true });
  }

  // ⑤ 删除
  items.push(
    { icon: <Trash2 size={14} />, label: "删除", onClick: opts.onDelete, danger: true, separator: true },
  );

  return items;
}

type CardMenuOpts = Parameters<typeof createCardMenuItems>[0];

/** 类型主操作：按条目类型挑选最具代表性的动作置顶高亮 */
function getPrimaryAction(opts: CardMenuOpts): { key: string; item: MenuItem } | null {
  const st = opts.itemSubType;
  const t = opts.itemType;

  // 图片：粘贴为 Markdown 图片
  if (t === "image" && opts.onPasteTransform) {
    return { key: "mdImage", item: { icon: <ImageIcon size={14} />, label: "粘贴为 Markdown 图片", onClick: () => opts.onPasteTransform!("md_image") } };
  }
  // 文件 / 路径：在资源管理器中显示
  if (opts.onRevealFile) {
    return { key: "reveal", item: { icon: <FolderOpen size={14} />, label: "在资源管理器中显示", onClick: opts.onRevealFile } };
  }
  // 链接：在浏览器中打开
  if (opts.hasUrl && opts.onOpenUrl) {
    return { key: "openUrl", item: { icon: <ExternalLink size={14} />, label: "在浏览器中打开", onClick: opts.onOpenUrl } };
  }
  // JSON：变换枢纽（SQL IN / INSERT / … 的统一入口，置顶高亮）
  if (st === "json" && opts.onOpenHub) {
    return { key: "hub", item: { icon: <Sparkles size={14} />, label: "变换为…", onClick: opts.onOpenHub } };
  }
  // 颜色：复制为 HEX
  if (st === "color" && opts.onPasteTransform) {
    return { key: "colorHex", item: { icon: <Palette size={14} />, label: "复制为 HEX", onClick: () => opts.onPasteTransform!("color_hex") } };
  }
  // 文本（含各子类型）：编辑内容
  if (opts.onEdit) {
    return { key: "edit", item: { icon: <Pencil size={14} />, label: editLabelFor(st), onClick: opts.onEdit } };
  }
  return null;
}

/** 类型工具：次级的类型相关操作（排除已作为主操作的项） */
function getTypeTools(opts: CardMenuOpts, primaryKey: string | null): MenuItem[] {
  const tools: MenuItem[] = [];
  const st = opts.itemSubType;

  // 编辑入口（主操作不是编辑时，作为次级工具）
  if (opts.onEdit && primaryKey !== "edit") {
    tools.push({ icon: <Pencil size={14} />, label: editLabelFor(st), onClick: opts.onEdit });
  }
  // 在浏览器中打开（主操作不是它时）
  if (opts.hasUrl && opts.onOpenUrl && primaryKey !== "openUrl") {
    tools.push({ icon: <ExternalLink size={14} />, label: "在浏览器中打开", onClick: opts.onOpenUrl });
  }
  // 用默认应用打开（路径 / 文件）
  if (opts.onOpenFile) {
    tools.push({ icon: <FileText size={14} />, label: "用默认应用打开", onClick: opts.onOpenFile });
  }
  // 在资源管理器中显示（主操作不是它时）
  if (opts.onRevealFile && primaryKey !== "reveal") {
    tools.push({ icon: <FolderOpen size={14} />, label: "在资源管理器中显示", onClick: opts.onRevealFile });
  }
  // 二维码（沿用现有 canQrCode 规则）
  if (opts.canQrCode && opts.onQrCode) {
    tools.push({ icon: <span style={{ fontSize: 14 }}>📱</span>, label: "生成二维码", onClick: opts.onQrCode });
  }
  // 变换枢纽（主操作不是它时，作为次级工具——如按列文本等非 json 内容）
  if (opts.onOpenHub && primaryKey !== "hub") {
    tools.push({ icon: <Sparkles size={14} />, label: "变换为…", onClick: opts.onOpenHub });
  }
  return tools;
}

/** 更多操作子菜单：标签/分组/置顶/片段库等管理项统一收纳 */
function getMoreChildren(opts: CardMenuOpts): MenuItem[] {
  const more: MenuItem[] = [];
  if (opts.onEditTags) {
    more.push({ icon: <Tag size={14} />, label: "编辑标签", onClick: opts.onEditTags });
  }
  if (opts.hasAutoTags && opts.onConfirmAutoTags) {
    more.push({ icon: <span style={{ fontSize: 14 }}>🤖</span>, label: "确认自动标签", onClick: opts.onConfirmAutoTags });
  }
  if (opts.hasAutoTags && opts.onRemoveAutoTags) {
    more.push({ icon: <span style={{ fontSize: 14 }}>🗑️</span>, label: "移除自动标签", onClick: opts.onRemoveAutoTags });
  }
  if (opts.onMoveToGroup) {
    more.push({ icon: <FolderInput size={14} />, label: "移动到分组", onClick: opts.onMoveToGroup, separator: more.length > 0 });
  }
  more.push({ icon: <Pin size={14} />, label: opts.pinned ? "取消置顶" : "置顶", onClick: opts.onPin });
  if (opts.onAddSnippet) {
    more.push({ icon: <FileCode size={14} />, label: "添加到片段库", onClick: opts.onAddSnippet });
  }
  return more;
}

/** 编辑入口的标签文案（按子类型） */
function editLabelFor(st?: string): string {
  const map: Record<string, string> = {
    link: "编辑链接",
    color: "编辑颜色",
    json: "编辑 JSON",
    file_path: "编辑路径",
    markdown: "编辑 Markdown",
    number: "编辑数字",
    secret: "编辑密钥",
    html: "编辑 HTML",
    csv: "编辑表格",
  };
  if (st && map[st]) return map[st];
  if (st && isCodeLike(st)) return "编辑代码";
  return "编辑内容";
}
