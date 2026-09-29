/**
 * RcDropdown — 会话浮条用的紧凑下拉（画质 / 画面 / 码率）。宿主是
 * `RcSessionCapsule`（画面顶缘的胶囊）和它的 ⋯ 面板。
 *
 * 为什么不用 `<select>`：原生 select 在各平台的弹出层完全不可控（Windows 上是
 * 系统绘制的白底列表，在深色会话条上像弹了个系统对话框），且没法显示 `tip`。
 *
 * 🔴 菜单用 portal 挂到 body（2026-09-22 修）。此前它是底栏内的 absolute 浮层，
 * 撞了两个坑：
 * 1. `.sessionBar` 带 `overflow-y: auto`（"换行高度封顶"那条），而菜单**向上**弹
 *    （`bottom: calc(100% + 6px)`）正好飞出底栏的 padding box ⇒ 被自己的滚动容器
 *    整块裁掉。CDP 实测：菜单 getBoundingClientRect 照样返回真实矩形，但
 *    `elementFromPoint` 在菜单中心命中的是画面区——用户点「画质」既看不见菜单，
 *    点击还穿透到画面被转发给远端（「点了没反应」）。
 * 2. `.sessionBar` 的 backdrop-filter 会创建层叠上下文，里面的 z-index 再高也压不过
 *    DOM 靠后的兄弟块（同 FullscreenEditor 工具栏那次踩过的坑）。
 *    portal 到 body 同时绕开这两条。
 *
 * 🧭 弹出方向交给 Floating UI（2026-09-29 修「画质菜单往上开出屏幕外」）。此前它
 * 手写 `bottom: innerHeight - btn.top + 6` 把自己**钉死在按钮上方**——那行坐标的
 * 前提是 2026-09-22 那条「底栏贴着窗口下沿」，而 2026-09-28 浮条统一之后三档下拉
 * 全都住在**画面顶缘**的胶囊/⋯ 面板里，前提反了：菜单往上弹正好撞穿视口上沿，
 * 8 项双列的画质菜单被截成一小截。现在改由 `flip` 判两侧空间（优先向下、放不下
 * 才向上）＋ `shift` 收回左右缘 ＋ `size` 把高度也封顶，窗口 resized/滚动由
 * `autoUpdate` 重算，不再自己量。见 `RcSessionCapsule` 的几何注释。
 *
 * 关闭时机：点击菜单外任意处（`mousedown` 而非 `click`——用户按下就表示想点别的，
 * 等 click 结束才关会让这一次点击落在被遮挡的元素上）。⚠️ 菜单已不在 wrapRef 里，
 * 内外两处都要判。
 *
 * 📐 「双列信息卡」（2026-09-22 二次修）。改前每项只有 2 字 label，fps / 宽度这些
 * **档位差异**全躺在 `tip` 里要逐项悬停，8 项单列 = 64.5 × 210px 的白条。
 * 现在：`meta` 把差异摆到明面、`columns` 排成两列、选中项有常驻勾位，
 * 外观也回到项目的浮层基准（对齐 `ContextMenu.module.css`）。
 * 列数**由调用方按 label 长度指定**，不自动猜——「码率」的 label 长到
 * 「200% · 尽量清晰」，硬拉两列会一宽一窄，那一档就该走单列。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  autoUpdate,
  flip,
  offset,
  shift,
  size,
  useFloating,
  useMergeRefs,
} from "@floating-ui/react";
import { Check, ChevronDown } from "lucide-react";
import { isSessionEscape } from "@/lib/rcKeyGuard";
import { registerRcPanel, unregisterRcPanel } from "@/lib/rcPanelFocus";
import styles from "./RemoteComputer.module.css";

/** 菜单与按钮的间距（px），沿用旧 CSS `calc(100% + 6px)` 的值。 */
const MENU_GAP = 6;
/** 贴边留白（px）：菜单比按钮宽时不许顶出窗口边缘（`shift`/`flip`/`size` 共用同一个数）。 */
const EDGE_PAD = 8;

/** 一项。`meta` / `solo` 只作用于菜单——按钮上的当前值仍只写 `label`。 */
export interface RcDropdownOption<T extends string> {
  key: T;
  /** 主文案 */
  label: string;
  /** 悬停说明（`title`） */
  tip: string;
  /** label 右侧的短补充（如 `10fps · 1280`）。不写则该行只有 label。 */
  meta?: string;
  /** 独占一整行，并在其后画一条分隔线（给「模式」类的项，如画质的「自动」）。 */
  solo?: boolean;
}

export function RcDropdown<T extends string>({
  label,
  value,
  options,
  columns = 1,
  disabled,
  disabledTitle,
  onPick,
  onOpenChange,
}: {
  /** 前缀名（画质 / 画面），当前值写在它右边。 */
  label: string;
  value: T;
  options: readonly RcDropdownOption<T>[];
  /** 菜单列数。label 短（2–3 字）且项多时用 2；label 长或项少时用 1。 */
  columns?: 1 | 2;
  disabled?: boolean;
  /** 禁用时的悬停说明（如「链路未连通，暂不能改档」）——禁用不许是哑巴（L1）。 */
  disabledTitle?: string;
  onPick: (k: T) => void;
  /**
   * 开合外报（2026-09-24 浮条收编）。菜单是 portal（fixed 挂 body），鼠标移进
   * 菜单不再经过宿主的画面热区/浮条矩形——宿主（RcSessionCapsule）需要用它
   * 在菜单展开期间锁住浮条显示，否则 2.5s 无交互淡出会把开着的菜单晾成孤儿。
   */
  onOpenChange?: (open: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);
  const popRef = useRef<HTMLDivElement>(null);

  /**
   * 坐标全交给 Floating UI：`bottom-start` 是**默认**方向（三档下拉都在画面顶缘，
   * 下方是整片画面），`flip` 在下方放不下时才翻到上方；`shift` 管左右缘，`size`
   * 同时把宽度对齐按钮、把高度封顶到剩余空间（配合 `.menuPop` 的 overflow，
   * 两侧都不够的极矮窗口里退化成滚动菜单，而不是被截断）。
   * `isPositioned` 用来压住首帧——旧代码靠「先定位再开」避免拿上次关闭时的旧坐标
   * 闪一下，这里改成挂载后先不可见，坐标到位才显形。
   */
  const { refs, floatingStyles, isPositioned } = useFloating({
    strategy: "fixed",
    open,
    placement: "bottom-start",
    middleware: [
      offset(MENU_GAP),
      flip({ fallbackPlacements: ["top-start"], padding: EDGE_PAD }),
      shift({ padding: EDGE_PAD }),
      size({
        padding: EDGE_PAD,
        // 这版 @floating-ui 的 `apply` 只收函数（对象简写在 0.27 的 dom 类型里没有），
        // 高度封顶和「菜单至少和按钮一样宽」都在这一处写，别再散回 CSS
        apply({ availableWidth, availableHeight, elements }) {
          const refW = elements.reference.getBoundingClientRect().width;
          Object.assign(elements.floating.style, {
            minWidth: `${Math.min(refW, availableWidth)}px`,
            maxHeight: `${availableHeight}px`,
          });
        },
      }),
    ],
    whileElementsMounted: autoUpdate,
  });

  /** setOpen 的唯一出口：状态与外报同源，避免两条路径漂移。 */
  const commit = useCallback(
    (v: boolean) => {
      setOpen(v);
      onOpenChange?.(v);
    },
    [onOpenChange],
  );

  // 点击菜单外任意处关闭
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      const t = e.target as Node;
      if (wrapRef.current?.contains(t) || popRef.current?.contains(t)) return;
      commit(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open, commit]);

  // 🔴 再审计（Esc 两级取消，2026-09-25）：展开期间向 rcPanelFocus 登记，
  // useRcInput 的 window 级 Esc 兜底据此让路，不直落「结束会话」确认；同时补
  // 「Esc 收起自己」——监听挂 document（冒泡先于 window 上的兜底），
  // stopPropagation 防止 Esc 穿透到会话兜底。effect/cleanup 严格配对，
  // StrictMode 双挂载下计数也平衡。
  useEffect(() => {
    if (!open) return;
    registerRcPanel();
    const onEsc = (e: KeyboardEvent) => {
      if (!isSessionEscape(e)) return;
      e.preventDefault();
      e.stopPropagation();
      commit(false);
    };
    document.addEventListener("keydown", onEsc);
    return () => {
      unregisterRcPanel();
      document.removeEventListener("keydown", onEsc);
    };
  }, [open, commit]);

  const current = options.find((o) => o.key === value);
  // ⚠️ 挂钩必须在顶层：`useMergeRefs` 写在 `{open && createPortal(...)}` 里面就是
  // 条件调用 hook（rules-of-hooks 直接报错）。
  const setPopRef = useMergeRefs([refs.setFloating, popRef]);
  // 坐标到位前不可见（旧代码靠「先定位再开」躲旧坐标闪一下，语义等价）
  const popClass = `${styles.menuPop}${columns === 2 ? ` ${styles.menuPopTwo}` : ""}${
    isPositioned ? "" : ` ${styles.menuPopPending}`
  }`;

  return (
    <div className={styles.menuWrap} ref={wrapRef}>
      <button
        ref={refs.setReference}
        type="button"
        className={styles.menuBtn}
        aria-haspopup="listbox"
        aria-expanded={open}
        title={disabled ? disabledTitle : undefined}
        disabled={disabled}
        onClick={() => {
          if (open) {
            commit(false);
            return;
          }
          commit(true);
        }}
      >
        {label} <b className={styles.menuCur}>{current?.label ?? value}</b>
        <ChevronDown size={12} className={styles.menuCaret} />
      </button>
      {open &&
        createPortal(
          <div
            ref={setPopRef}
            // 再审计 A9（2026-09-25）：portal 挂在 body，父级「点外收起」的
            // contains 判定够不到这里——用这个标记让点外收起豁免菜单内点击
            data-rc-portal-menu=""
            className={popClass}
            role="listbox"
            aria-label={label}
            style={floatingStyles}
          >
            {options.flatMap((o, i) => {
              const on = o.key === value;
              const cls = `${styles.menuItem}${on ? ` ${styles.menuItemOn}` : ""}${
                o.solo ? ` ${styles.menuItemSolo}` : ""
              }`;
              const item = (
                <button
                  key={o.key}
                  type="button"
                  role="option"
                  aria-selected={on}
                  title={o.tip}
                  className={cls}
                  onClick={() => {
                    commit(false);
                    onPick(o.key);
                  }}
                >
                  {/* 勾位常驻、靠 opacity 切换：条件渲染会让未选中项的文字左移一整个勾宽 */}
                  <Check className={styles.menuCheck} size={12} aria-hidden="true" />
                  {o.label}
                  {o.meta && <span className={styles.menuMeta}>{o.meta}</span>}
                </button>
              );
              // solo 项与其后一段之间补分隔线；末项不补，免得菜单底部多一条悬空的线
              return o.solo && i < options.length - 1
                ? [item, <span key={`${o.key}-sep`} className={styles.menuSep} />]
                : [item];
            })}
          </div>,
          document.body,
        )}
    </div>
  );
}
