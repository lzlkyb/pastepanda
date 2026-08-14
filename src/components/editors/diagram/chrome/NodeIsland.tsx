/**
 * 属性浮岛：贴在选中节点上方的一排高频动作（宽档专用）。
 *
 * 为何只放高频、不把整个属性面板搬过来：完整面板 220×约 215px（开 AI 约 300px），
 * 贴在节点头上会盖掉下游一大片——而看下游正是编流程图时最需要的。
 * 这也是 tldraw（contextual toolbar 只一排）与 Excalidraw（属性 Island 固定在左侧、
 * 不跟选区）的共同选择：两家都没把完整面板钉在选区上。
 *
 * 低频属性（文字 / 描边色 / 全 11 种形状 / 字号 / 焦点）在右上固定面板，由「⋯」切开关。
 */
import { useEffect, useRef, useState, type RefObject } from "react";
import { Sparkles, Trash2, MoreHorizontal } from "lucide-react";
import { NODE_COLORS, type DNode, type NodeShape } from "@/lib/diagram/types";
import { SHAPES } from "../shapes";
import { placeAnchored } from "./place";
import { useNodeAnchor } from "./useNodeAnchor";
import styles from "../../DiagramCanvas.module.css";

/** 浮岛上只放这四种形状：流程图里绝大多数节点就是它们。其余七种走「⋯」里的完整网格。 */
const QUICK_SHAPES: NodeShape[] = ["rect", "round", "diamond", "pill"];
/** 同理，颜色只放前三个；全色盘在面板里 */
const QUICK_COLOR_COUNT = 3;

export function NodeIsland({
  node, rootRef, aiOn, aiBusy, moreOpen,
  onShape, onColor, onExpand, onDelete, onToggleMore,
}: {
  node: DNode;
  rootRef: RefObject<HTMLElement | null>;
  aiOn: boolean;
  aiBusy: boolean;
  moreOpen: boolean;
  onShape: (s: NodeShape) => void;
  onColor: (c: string) => void;
  onExpand: () => void;
  onDelete: () => void;
  onToggleMore: () => void;
}) {
  const anchor = useNodeAnchor(rootRef, node);
  const elRef = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  // 浮岛自身尺寸要量，而且**必须用 ResizeObserver 而不是 useLayoutEffect + 依赖数组**：
  //
  // 首帧 anchor 为 null（useNodeAnchor 要等自己的 ResizeObserver 拿到容器尺寸），
  // 本组件下面直接 return null → 没有 DOM → elRef.current 是 null → 测量跳过。
  // 等下一帧真渲染出 div 时，如果依赖只写 [aiOn]、它没变 → 测量不会再执行
  // → size 永远停在 {0,0} → 下方 visibility 判断把浮岛**永久隐藏**（在 DOM 里但看不见）。
  // 盯元素本身的 RO 挂上就会回调，附带把 aiOn 切换、字体加载引起的尺寸变动一并盖住。
  const hasAnchor = anchor !== null;
  useEffect(() => {
    const el = elRef.current;
    if (!el) return;
    const ro = new ResizeObserver(() => {
      setSize({ width: el.offsetWidth, height: el.offsetHeight });
    });
    ro.observe(el);
    return () => ro.disconnect();
    // anchor 从 null 变非 null 时才有 DOM，那一刻必须重新挂观察
  }, [hasAnchor]);

  if (!anchor) return null;
  const pos = placeAnchored(anchor.rect, size, anchor.container);

  return (
    <div
      ref={elRef}
      className={`${styles.island} ${pos.below ? styles.islandBelow : ""}`}
      // 首帧 size 为 0 时先隐起来，避免它在计算出正确位置前闪一下
      style={{ left: pos.left, top: pos.top, visibility: size.width ? "visible" : "hidden" }}
    >
      {QUICK_SHAPES.map((key) => {
        const spec = SHAPES.find((s) => s.key === key);
        if (!spec) return null;
        return (
          <button
            key={key}
            className={`${styles.islandBtn} ${(node.data.shape || "rect") === key ? styles.islandBtnOn : ""}`}
            title={`${spec.label} · ${spec.hint}`}
            onClick={() => onShape(key)}
          >
            {spec.icon}
          </button>
        );
      })}

      <span className={styles.islandDivider} />

      {NODE_COLORS.slice(0, QUICK_COLOR_COUNT).map((c) => (
        <button key={c} className={styles.islandBtn} title={`节点颜色 ${c}`} onClick={() => onColor(c)}>
          <span className={styles.islandDot} style={{ background: c }} />
        </button>
      ))}

      <span className={styles.islandDivider} />

      {/* 红线 #16：AI 未配置时入口完全不渲染 */}
      {aiOn && (
        <button className={styles.islandBtn} title="AI 展开子流程" disabled={aiBusy} onClick={onExpand}>
          <Sparkles size={15} />
        </button>
      )}
      <button className={`${styles.islandBtn} ${styles.islandBtnDanger}`} title="删除节点" onClick={onDelete}>
        <Trash2 size={15} />
      </button>

      <span className={styles.islandDivider} />

      <button
        className={`${styles.islandBtn} ${moreOpen ? styles.islandBtnOn : ""}`}
        title={moreOpen ? "收起完整属性" : "更多属性（文字 / 描边 / 全 11 种形状 / 字号 / 焦点）"}
        onClick={onToggleMore}
      >
        <MoreHorizontal size={15} />
      </button>
    </div>
  );
}
