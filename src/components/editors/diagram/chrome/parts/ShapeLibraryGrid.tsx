/**
 * 形状库的两列网格内容——**两套布局共用这一份**，不拿容器与定位。
 * 宽档把它放进常驻的左侧竖栏，紧凑档放进工具栏的 popover。
 *
 * 按 SHAPE_GROUPS 分段（基础 / 流程 / 数据）：11 个形状平铺两列时，
 * 菱形与圆柱靠在一起看不出语义差别，找一个要从头扫到尾。
 * 分组只改渲染，数据仍然是 shapes.tsx 那一份（规则 #11）。
 */
import { SHAPES, SHAPE_GROUPS } from "../../shapes";
import type { NodeShape } from "@/lib/diagram/types";
import { SHAPE_DRAG_MIME, GROUP_DRAG_KEY, type DragKind } from "../types";
import styles from "../../../DiagramCanvas.module.css";

export function ShapeLibraryGrid({
  onAddShape, onAddGroup, onDragShape,
}: {
  onAddShape: (s: NodeShape) => void;
  onAddGroup: () => void;
  onDragShape: (s: DragKind | null) => void;
}) {
  return (
    <>
      <div className={styles.libTitle}>形状</div>
      {SHAPE_GROUPS.map((g, gi) => {
        const items = SHAPES.filter((s) => s.group === g);
        if (items.length === 0) return null;
        return (
          <div key={g} className={styles.libSection}>
            {/* 第一个组不留上边距与分隔线：它紧跟在「形状」总标题下面，再画一条线就成了双线 */}
            <div className={`${styles.libGroup} ${gi === 0 ? styles.libGroupFirst : ""}`}>{g}</div>
            {items.map((s, i) => {
              // 组内个数为奇数时，最后一格横跨两列，不要在右下角留个空洞。
              // 判断要按**组内**长度而不是总长度：分组后每个组都是独立的两列网格。
              const wide = i === items.length - 1 && items.length % 2 === 1;
              return (
                <button
                  key={s.key}
                  className={`${styles.libShapeBtn} ${wide ? styles.libShapeWide : ""}`}
                  title={`${s.label} · ${s.hint}（可拖到画布）`}
                  onClick={() => onAddShape(s.key)}
                  // 拖到画布落点建节点；**点一下加到画布中心的旧行为保留**（触屏与习惯兼容）
                  draggable
                  onDragStart={(e) => {
                    e.dataTransfer.setData(SHAPE_DRAG_MIME, s.key);
                    e.dataTransfer.effectAllowed = "copy";
                    onDragShape(s.key);
                  }}
                  onDragEnd={() => onDragShape(null)}
                >
                  <span className={styles.libShapeIco}>{s.icon}</span>
                  <span className={styles.libShapeLbl}>{s.label}</span>
                </button>
              );
            })}
          </div>
        );
      })}

      {/* 区域框单独一段：它不是 NodeShape（不对应任何 Mermaid 形状），不能混进 SHAPES，
          否则形状选择器 / Mermaid 导出都会多出一个表达不了的值。拖放走同一个通道。 */}
      <div className={styles.libSection}>
        <div className={styles.libGroup}>分组</div>
        <button
          className={`${styles.libShapeBtn} ${styles.libShapeWide} ${styles.libGroupBtn}`}
          title="区域框 · 把一组节点圈起来（可拖到画布）"
          onClick={onAddGroup}
          draggable
          onDragStart={(e) => {
            e.dataTransfer.setData(SHAPE_DRAG_MIME, GROUP_DRAG_KEY);
            e.dataTransfer.effectAllowed = "copy";
            onDragShape(GROUP_DRAG_KEY);
          }}
          onDragEnd={() => onDragShape(null)}
        >
          <span className={styles.libShapeIco}>
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.7} strokeLinejoin="round">
              <rect x="3" y="5" width="18" height="14" rx="2" strokeDasharray="3 2" />
              <path d="M3 9h7" />
            </svg>
          </span>
          <span className={styles.libShapeLbl}>区域框</span>
        </button>
      </div>
    </>
  );
}
