/**
 * 与布局档位无关的两个浮层：形状拖拽的落点预览 + 右键菜单。
 *
 * 它们不进 RoomyChrome / CompactChrome：一个跟鼠标、一个弹在鼠标处，
 * 两者都不依赖“哪套布局”，所以由画布直接渲染、两档共用同一份。
 */
import { SHAPES } from "../shapes";
import { GROUP_DRAG_KEY, type DragKind } from "./types";
import { ContextMenu, type MenuState, type MenuActions } from "./ContextMenu";
import styles from "../../DiagramCanvas.module.css";

export function CanvasOverlays({
  dragShape, dropAt, menu, menuActions, onCloseMenu,
}: {
  dragShape: DragKind | null;
  dropAt: { x: number; y: number } | null;
  menu: MenuState | null;
  menuActions: MenuActions;
  onCloseMenu: () => void;
}) {
  return (
    <>
      {/* 拖拽落点预览。pointer-events:none 写在 CSS 里——否则它自己会吃掉 dragover，
          预览框一出现就再也不跟鼠标了 */}
      {dragShape && dropAt && (
        <div className={styles.dropGhost} style={{ left: dropAt.x, top: dropAt.y }}>
          {dragShape === GROUP_DRAG_KEY
            ? "区域框"
            : SHAPES.find((s) => s.key === dragShape)?.label ?? "节点"}
        </div>
      )}

      {menu && <ContextMenu state={menu} actions={menuActions} onClose={onCloseMenu} />}
    </>
  );
}
