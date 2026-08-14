/**
 * 宽档布局（画布容器 ≥ 760px）：左侧形状竖栏 + 顶部工具栏 + 属性浮岛 + 底部居中状态栏。
 *
 * 本文件只拥有「怎么摆」，控件全部来自 parts/（与紧凑档共用同一份）。
 *
 * 选中节点时弹的是**贴选区的浮岛**（高频动作），完整属性面板默认收起、由浮岛上的「⋯」展开。
 * 为何不把整个面板贴到节点旁：见 NodeIsland 的文件注释。
 *
 * 工具栏 left 从 12px 让到 174px（150 库宽 + 12 间距 + 12 边距）：
 * 原先形状库 top:64 / 工具栏 top:12，两条玻璃边框上下只隔 4px，看起来是一块被撕开。
 */
import { useState, type RefObject } from "react";
import { isGroup } from "@/lib/diagram/types";
import type { ChromeActions } from "./types";
import { ToolActions } from "./parts/ToolActions";
import { ShapeLibraryGrid } from "./parts/ShapeLibraryGrid";
import { NodeIsland } from "./NodeIsland";
import {
  LabelField, ColorSwatches, StrokeSwatches, TextColorSwatches, ShapeGrid,
  FontSizeBtns, FocalToggle, AiEnhance, DeleteBtn, EdgeLabelField, EdgeLineBtns,
} from "./parts/fields";
import styles from "../../DiagramCanvas.module.css";

export function RoomyChrome({ a, rootRef }: { a: ChromeActions; rootRef: RefObject<HTMLElement | null> }) {
  // 完整面板的开关。
  //
  // 宽档（≥760px）默认**展开**：空间已经够了，再让用户多点一下没意义。
  // 这里与紧凑档故意不同（那边默认收起）：**画布越宽，默认露得越多**。
  // 之前两档都默认收起，反而出现了“全屏比小弹框露得还少”。
  //
  // **故意不随选区重置**：用户手动收起后连着改几个节点，每换一个就弹回来反而折腾。
  const [moreOpen, setMoreOpen] = useState(true);

  // 区域框与普通节点共用 selectedNode（它们同在 doc.nodes 里），但属性完全不同：
  // 框没有形状 / 字号 / 描边 / 焦点，也不能走 AI 展开。这里先分开，下面各走各的。
  const nodeSel = a.selectedNode && !isGroup(a.selectedNode) ? a.selectedNode : null;
  const groupSel = a.selectedNode && isGroup(a.selectedNode) ? a.selectedNode : null;

  return (
    <>
      <div className={`${styles.shapeLibrary} ${styles.libRail}`}>
        <ShapeLibraryGrid onAddShape={a.addShape} onAddGroup={a.addGroup} onDragShape={a.onDragShape} />
      </div>

      <div className={`${styles.toolbar} ${styles.toolbarRoomy}`}>
        <ToolActions a={a} />
      </div>

      {nodeSel && (
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

      {nodeSel && moreOpen && (
        <div className={styles.propPanel}>
          <div className={styles.propTitle}>节点属性</div>

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
          <div className={styles.propRowStack}>
            <span>形状</span>
            <ShapeGrid node={nodeSel} onShape={a.onShape} cols={4} />
          </div>
          <div className={styles.propRow}>
            <span>字号</span>
            <FontSizeBtns node={nodeSel} onFontSize={a.onFontSize} />
          </div>
          <div className={styles.propRow}>
            <span>焦点路径</span>
            <FocalToggle node={nodeSel} onFocal={a.onFocal} />
          </div>

          {a.aiOn && <AiEnhance busy={a.aiBusy} onPolish={a.onPolish} onExpand={a.onExpand} />}

          <DeleteBtn onDelete={a.onDeleteNode} label="删除节点" />
        </div>
      )}

      {/* 区域框：只有标题与颜色两项，不弹浮岛（没有高频动作值得贴到选区旁） */}
      {groupSel && (
        <div className={styles.propPanel}>
          <div className={styles.propTitle}>分组属性</div>
          <div className={styles.propRow}>
            <span>标题</span>
            <LabelField node={groupSel} onLabel={a.onLabel} />
          </div>
          <div className={styles.propRow}>
            <span>颜色</span>
            <ColorSwatches node={groupSel} onColor={a.onColor} />
          </div>
          <DeleteBtn onDelete={a.onDeleteNode} label="删除分组（不删节点）" />
        </div>
      )}

      {/* 连线不弹浮岛：它只有说明 / 线型 / 删除三项，右键菜单已经盖全，固定面板就够 */}
      {a.selectedEdge && !a.selectedNode && (
        <div className={styles.propPanel}>
          <div className={styles.propTitle}>连线属性</div>
          <div className={styles.propRow}>
            <span>说明</span>
            <EdgeLabelField edge={a.selectedEdge} onLabel={a.onEdgeLabel} />
          </div>
          <div className={styles.propRow}>
            <span>线型</span>
            <EdgeLineBtns edge={a.selectedEdge} onLine={a.onEdgeLine} />
          </div>
          <DeleteBtn onDelete={() => a.onDeleteEdge(a.selectedEdge!.id)} label="删除连线" />
        </div>
      )}

      {/* 底部居中是唯一空位：左下被 <Controls> 占、右下被 <MiniMap> 占 */}
      <div className={styles.statusBar}>
        <span>节点 <b>{a.nodeCount}</b></span>
        <span className={styles.statusDivider} />
        <span>连线 <b>{a.edgeCount}</b></span>
        <span className={styles.statusDivider} />
        <span>{a.layoutEngine === "dagre" ? "紧凑" : a.layoutEngine === "elk" ? "大图" : "自动"}</span>
        <span className={styles.statusDivider} />
        <span><b>{Math.round(a.zoom * 100)}%</b></span>
      </div>
    </>
  );
}
