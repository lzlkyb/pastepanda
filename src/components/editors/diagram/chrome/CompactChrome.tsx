/**
 * 紧凑档布局（画布容器 < 760px，默认 480px 窗口下弹窗 402 / 全屏 448 都落这里）。
 *
 * 与宽档三处关键不同，都是为了不在横向上挤：
 *  1. 属性面板从右侧竖条改成**贴底抽屉**。宽档三块并排需 758px，
 *     402px 下工具栏(12‥352) 与右面板(206‥390) 会重叠 146px。
 *  2. 形状库从常驻竖栏改成工具栏里的 popover。
 *  3. 工具栏隐文字只留图标（340 → 约 293px）。
 *
 * 抽屉 left 从 46px 起（CSS 里）：让开左下的 <Controls>，否则一开抽屉就把缩放按钮盖死。
 * MiniMap 在这一档根本不渲染（见 DiagramCanvas）：132px 小地图在 402px 画布上没意义，
 * 且位置正好被抽屉盖住。
 */
import { useEffect, useState, type RefObject } from "react";
import { Shapes } from "lucide-react";
import { ISLAND_MIN_WIDTH, type ChromeActions } from "./types";
import { useNodeAnchor } from "./useNodeAnchor";
import { NodeIsland } from "./NodeIsland";
import { ToolActions } from "./parts/ToolActions";
import { ShapeLibraryGrid } from "./parts/ShapeLibraryGrid";
import {
  LabelField, ColorSwatches, StrokeSwatches, TextColorSwatches, ShapeGrid,
  FontSizeBtns, FocalToggle, AiEnhance, DeleteBtn, EdgeLabelField, EdgeLineBtns,
} from "./parts/fields";
import { isGroup, type NodeShape } from "@/lib/diagram/types";
import styles from "../../DiagramCanvas.module.css";

export function CompactChrome({ a, rootRef }: { a: ChromeActions; rootRef: RefObject<HTMLElement | null> }) {
  const [shapeOpen, setShapeOpen] = useState(false);
  // 完整属性（贴底抽屉）的开关，由浮岛上的「⋯」切。
  //
  // 这一档（380–760px）默认**收起**：抽屉一开就吃掉画布底部一大块，
  // 而这个尺寸区间本来就紧。宽档（≥760）相反，空间够就默认展开（见 RoomyChrome）。
  const [moreOpen, setMoreOpen] = useState(false);

  // 区域框与普通节点共用 selectedNode，但属性完全不同（框没有形状 / 字号 / 描边 / 焦点）。
  // 先分开，下面各走各的；浮岛与完整抽屉都只服务普通节点。
  const nodeSel = a.selectedNode && !isGroup(a.selectedNode) ? a.selectedNode : null;
  const groupSel = a.selectedNode && isGroup(a.selectedNode) ? a.selectedNode : null;

  // 抽屉随选中节点翻面：节点在画布上半 → 抽屉贴底，在下半 → 抽屉贴顶，
  // 这样抽屉永远不盖住选中的那个节点。连线不参与翻面（它没有单一位置），默认贴底。
  const anchor = useNodeAnchor(rootRef, nodeSel);
  const sheetOnTop =
    anchor !== null && anchor.rect.top + anchor.rect.height / 2 > anchor.container.height / 2;
  const sheetClass = `${styles.propSheet} ${sheetOnTop ? styles.propSheetTop : ""}`;

  // 浮岛只看「画布够不够宽装得下它」，**不跟布局档位绑定**——760 那个阈值管的是
  // 三块并排，与浮岛无关。两者当初共用一个开关，导致 600px 窗口下浮岛永远不出现。
  const islandFits = anchor !== null && anchor.container.width >= ISLAND_MIN_WIDTH;

  // 抽屉何时开：有浮岛时听「⋯」，装不下浮岛（画布 <380）时选中就开。
  //
  // 多一道 anchor !== null 是关键：量不到容器尺寸时 islandFits 也是 false，
  // 旧写法会把这个**失败态**当成“极窄”而自动展开全属性抽屉——弹框有入场动画，
  // 测量比全屏晚，正好落这个分支，于是出现“弹框比全屏露得还多”。量不到就什么都不画，等下一帧。
  const nodeSheetOpen = Boolean(nodeSel) && anchor !== null && (!islandFits || moreOpen);
  const sheetOpen = nodeSheetOpen || Boolean(groupSel) || Boolean(a.selectedEdge);

  // Esc 关 popover。不调 preventDefault / stopPropagation：画布自己的 Esc（取消选中）
  // 还要能收到，这里只是顺手把 popover 关上。
  useEffect(() => {
    if (!shapeOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setShapeOpen(false);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [shapeOpen]);

  const pick = (s: NodeShape) => {
    a.addShape(s);
    setShapeOpen(false);
  };

  return (
    <>
      <div className={`${styles.toolbar} ${styles.toolbarCompact}`}>
        <button
          className={`${styles.toolBtn} ${shapeOpen ? styles.toolBtnOn : ""}`}
          title="形状库"
          onClick={() => setShapeOpen((v) => !v)}
        >
          <Shapes size={15} />
          <span className={styles.caret}>▾</span>
        </button>
        <ToolActions a={a} />
      </div>

      {shapeOpen && (
        <>
          {/* 透明遮罩：点画布任意处关形状库。放在 popover 之下一层 */}
          <div className={styles.popBackdrop} onClick={() => setShapeOpen(false)} />
          <div className={`${styles.shapeLibrary} ${styles.libPop}`}>
            <ShapeLibraryGrid
              onAddShape={pick}
              onAddGroup={() => {
                a.addGroup();
                setShapeOpen(false);
              }}
              onDragShape={a.onDragShape}
            />
          </div>
        </>
      )}

      {/* 无选中时才显状态：抽屉一开就会盖住右下，而计数已在抽屉标题行里 */}
      {!sheetOpen && (
        <div className={`${styles.statusBar} ${styles.statusMini}`}>
          <span>节点 <b>{a.nodeCount}</b></span>
          <span className={styles.statusDivider} />
          <span><b>{Math.round(a.zoom * 100)}%</b></span>
        </div>
      )}

      {nodeSel && islandFits && (
        <NodeIsland
          node={nodeSel}
          rootRef={rootRef}
          aiOn={a.aiOn}
          aiBusy={a.aiBusy}
          moreOpen={moreOpen}
          onShape={a.onShape}
          onColor={a.onColor}
          onExpand={a.onExpand}
          onDelete={a.onDeleteNode}
          onToggleMore={() => setMoreOpen((v) => !v)}
        />
      )}

      {/* 区域框：只有标题与颜色，需要很小的空间，直接贴底。
          不走 sheetClass 的翻面逻辑：那一套靠 useNodeAnchor 量选中节点位置，而区域框本身就很大，
          “不盖住选中对象”无从谈起。 */}
      {groupSel && (
        <div className={styles.propSheet}>
          <div className={styles.sheetHead}>
            <span className={styles.sheetTitle}>分组属性</span>
            <span className={styles.sheetMeta}>
              节点 {a.nodeCount} · 连线 {a.edgeCount} · {Math.round(a.zoom * 100)}%
            </span>
            <DeleteBtn onDelete={a.onDeleteNode} label="删除分组（不删节点）" iconOnly />
          </div>
          <div className={styles.sheetGrid}>
            <div className={styles.propRow}>
              <span>标题</span>
              <LabelField node={groupSel} onLabel={a.onLabel} />
            </div>
            <div className={styles.propRow}>
              <span>颜色</span>
              <ColorSwatches node={groupSel} onColor={a.onColor} />
            </div>
          </div>
        </div>
      )}

      {nodeSheetOpen && nodeSel && (
        <div className={sheetClass}>
          <div className={styles.sheetHead}>
            <span className={styles.sheetTitle}>节点属性</span>
            <span className={styles.sheetMeta}>
              节点 {a.nodeCount} · 连线 {a.edgeCount} · {Math.round(a.zoom * 100)}%
            </span>
            <DeleteBtn onDelete={a.onDeleteNode} label="删除节点" iconOnly />
          </div>

          <div className={styles.sheetGrid}>
            <div className={styles.propRow}>
              <span>文字</span>
              <LabelField node={nodeSel} onLabel={a.onLabel} />
            </div>
            <div className={styles.propRow}>
              <span>颜色</span>
              <ColorSwatches node={nodeSel} onColor={a.onColor} />
            </div>
            <div className={styles.propRow}>
              <span>描边</span>
              <StrokeSwatches node={nodeSel} onStroke={a.onStroke} />
            </div>
            <div className={styles.propRow}>
              <span>文字色</span>
              <TextColorSwatches node={nodeSel} onTextColor={a.onTextColor} />
            </div>
            <div className={styles.propRow}>
              <span>字号</span>
              <FontSizeBtns node={nodeSel} onFontSize={a.onFontSize} />
            </div>
            <div className={`${styles.propRowStack} ${styles.sheetFull}`}>
              <span>形状</span>
              <ShapeGrid node={nodeSel} onShape={a.onShape} cols={6} />
            </div>
            <div className={styles.propRow}>
              <span>焦点路径</span>
              <FocalToggle node={nodeSel} onFocal={a.onFocal} />
            </div>
            {a.aiOn && (
              <div className={styles.sheetFull}>
                <AiEnhance busy={a.aiBusy} onPolish={a.onPolish} onExpand={a.onExpand} />
              </div>
            )}
          </div>
        </div>
      )}

      {a.selectedEdge && !a.selectedNode && (
        <div className={styles.propSheet}>
          <div className={styles.sheetHead}>
            <span className={styles.sheetTitle}>连线属性</span>
            <span className={styles.sheetMeta}>
              节点 {a.nodeCount} · 连线 {a.edgeCount} · {Math.round(a.zoom * 100)}%
            </span>
            <DeleteBtn onDelete={() => a.onDeleteEdge(a.selectedEdge!.id)} label="删除连线" iconOnly />
          </div>
          <div className={styles.sheetGrid}>
            <div className={styles.propRow}>
              <span>说明</span>
              <EdgeLabelField edge={a.selectedEdge} onLabel={a.onEdgeLabel} />
            </div>
            <div className={styles.propRow}>
              <span>线型</span>
              <EdgeLineBtns edge={a.selectedEdge} onLine={a.onEdgeLine} />
            </div>
          </div>
        </div>
      )}
    </>
  );
}
