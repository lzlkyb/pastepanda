/**
 * 右键菜单：节点 / 连线 / 画布三种上下文。
 *
 * **不分宽档紧凑档**，两档共用——右键弹在鼠标处，本身就不依赖布局，
 * 所以它由 DiagramCanvas 直接渲染，不进两个 chrome 壳。
 *
 * 菜单项只暴露**已有的动作**，不新增能力；快捷键标注与 useDiagramShortcuts 里的真实绑定一致。
 */
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { Copy, CopyPlus, Sparkles, Trash2, Plus, LayoutGrid, Maximize, FileCode, ClipboardPaste, Star } from "lucide-react";
import type { EdgeLine } from "@/lib/diagram/types";
import { placeMenu, type Size } from "./place";
import css from "../../DiagramCanvas.module.css";

/** 右键命中的东西。flowPos 只有画布菜单用到（「在此添加节点」的落点） */
export type MenuTarget =
  // group=true 时隐掉 AI 与焦点路径：区域框没有“步骤文案”可润色，
  // 焦点描边也只在 .node 上有样式，点了只会默默写一个不生效的字段。
  | { kind: "node"; id: string; focal: boolean; group?: boolean }
  | { kind: "edge"; id: string; line: EdgeLine }
  | { kind: "pane"; flowPos: { x: number; y: number } };

export interface MenuState {
  /** 容器坐标（已减过 .root 的原点） */
  x: number;
  y: number;
  target: MenuTarget;
  /** 右键时量一次的容器尺寸。存进 state 而不是每帧重读：
   *  菜单开着的短时间里容器不会变，而 getBoundingClientRect 是同步布局。 */
  container: Size;
}

export interface MenuActions {
  duplicateNode: (id: string) => void;
  copySelected: () => void;
  pasteClipboard: () => void;
  /** 函数而不是布尔值：剪贴板内容存在 ref 里，写成值会在菜单渲染时就定住、拿到陈旧状态 */
  hasClipboard: () => boolean;
  aiOn: boolean;
  aiBusy: boolean;
  polish: () => void;
  expand: () => void;
  setFocal: (v: boolean) => void;
  deleteNode: (id: string) => void;
  setEdgeLine: (id: string, line: EdgeLine) => void;
  deleteEdge: (id: string) => void;
  addNodeAt: (pos: { x: number; y: number }) => void;
  layout: () => void;
  fitView: () => void;
  openImport: () => void;
}

const LINE_ITEMS: { k: EdgeLine; label: string }[] = [
  { k: "solid", label: "── 实线" },
  { k: "dashed", label: "╌╌ 虚线" },
  { k: "thick", label: "━━ 粗线" },
];

export function ContextMenu({
  state, actions, onClose,
}: {
  state: MenuState;
  actions: MenuActions;
  onClose: () => void;
}) {
  const elRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useLayoutEffect(() => {
    const el = elRef.current;
    if (!el) return;
    setSize({ width: el.offsetWidth, height: el.offsetHeight });
  }, [state]);

  // Esc 关菜单。useDiagramShortcuts 里没绑 Esc，不会抢。
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const pos = placeMenu({ x: state.x, y: state.y }, size, state.container);
  const run = (fn: () => void) => () => {
    fn();
    onClose();
  };

  const t = state.target;
  return (
    <>
      {/* 透明遮罩：点任意处关菜单。必须阻止它自己的右键，否则在菜单开着时
          再右键会弹出浏览器原生菜单 */}
      <div
        className={css.menuBackdrop}
        onClick={onClose}
        onContextMenu={(e) => {
          e.preventDefault();
          onClose();
        }}
      />
      <div ref={elRef} className={css.menu} style={{ left: pos.left, top: pos.top, visibility: size.width ? "visible" : "hidden" }}>
        {t.kind === "node" && (
          <>
            <button className={css.menuItem} onClick={run(() => actions.duplicateNode(t.id))}>
              <CopyPlus size={14} /> 副本<span className={css.menuKbd}>Ctrl+D</span>
            </button>
            <button className={css.menuItem} onClick={run(actions.copySelected)}>
              <Copy size={14} /> 复制<span className={css.menuKbd}>Ctrl+C</span>
            </button>
            {actions.aiOn && !t.group && (
              <>
                <div className={css.menuSep} />
                <button className={css.menuItem} disabled={actions.aiBusy} onClick={run(actions.polish)}>
                  <Sparkles size={14} /> AI 润色文案
                </button>
                <button className={css.menuItem} disabled={actions.aiBusy} onClick={run(actions.expand)}>
                  <Sparkles size={14} /> AI 展开子流程
                </button>
              </>
            )}
            {!t.group && (
              <>
                <div className={css.menuSep} />
                <button className={css.menuItem} onClick={run(() => actions.setFocal(!t.focal))}>
                  <Star size={14} /> {t.focal ? "取消焦点路径" : "设为焦点路径"}
                </button>
              </>
            )}
            <div className={css.menuSep} />
            <button className={`${css.menuItem} ${css.menuItemDanger}`} onClick={run(() => actions.deleteNode(t.id))}>
              <Trash2 size={14} /> {t.group ? "删除分组" : "删除"}<span className={css.menuKbd}>Del</span>
            </button>
          </>
        )}

        {t.kind === "edge" && (
          <>
            {LINE_ITEMS.map((o) => (
              <button
                key={o.k}
                className={`${css.menuItem} ${t.line === o.k ? css.menuItemOn : ""}`}
                onClick={run(() => actions.setEdgeLine(t.id, o.k))}
              >
                {o.label}
              </button>
            ))}
            <div className={css.menuSep} />
            <button className={`${css.menuItem} ${css.menuItemDanger}`} onClick={run(() => actions.deleteEdge(t.id))}>
              <Trash2 size={14} /> 删除连线<span className={css.menuKbd}>Del</span>
            </button>
          </>
        )}

        {t.kind === "pane" && (
          <>
            <button className={css.menuItem} onClick={run(() => actions.addNodeAt(t.flowPos))}>
              <Plus size={14} /> 在此添加节点
            </button>
            <button className={css.menuItem} disabled={!actions.hasClipboard()} onClick={run(actions.pasteClipboard)}>
              <ClipboardPaste size={14} /> 粘贴<span className={css.menuKbd}>Ctrl+V</span>
            </button>
            <div className={css.menuSep} />
            <button className={css.menuItem} onClick={run(actions.layout)}>
              <LayoutGrid size={14} /> 自动布局<span className={css.menuKbd}>L</span>
            </button>
            <button className={css.menuItem} onClick={run(actions.fitView)}>
              <Maximize size={14} /> 适应视图<span className={css.menuKbd}>F</span>
            </button>
            <div className={css.menuSep} />
            <button className={css.menuItem} onClick={run(actions.openImport)}>
              <FileCode size={14} /> 从 Mermaid 导入…
            </button>
          </>
        )}
      </div>
    </>
  );
}
