/**
 * result 态的出口面板（完成截图后选择去向）。
 *
 * 纯展示组件。敏感内容只在这里做**提示**，真正的拦截在父组件的各个 onXxx 里（规则 16）——
 * 展示层不能成为安全边界。
 */

interface Props {
  /** 供父组件实测面板尺寸（高度随出口数量变，写死算不准） */
  innerRef?: React.Ref<HTMLDivElement>;
  /** 位置（父组件用 layoutToolbar 算好）。
   *  旧实现写在 CSS 里钉死屏幕右下角，与选区无关。 */
  left: number;
  top: number;
  /** 附着方向（决定 tooltip 方向，与工具栏同一套语义） */
  attach: "below" | "above" | "inside";
  /** 命中的敏感内容类型（null = 未命中） */
  sensitiveKind: string | null;
  /** AI 可用（规则 16：必然出网的两项在不可用时不渲染） */
  aiOk: boolean;
  hasFixedRegion: boolean;
  /** 刚保存过固定区域（短暂反馈） */
  regionSaved: boolean;
  /** 当前编辑器打开的文件路径（null = 未打开，不显示插入出口） */
  editorTarget: string | null;
  onCopyImage: () => void;
  onSaveToGallery: () => void;
  onPinImage: () => void;
  onOpenAi: () => void;
  onTranslate: () => void;
  onOpenChains: () => void;
  /** 记住 / 清除固定区域（由 hasFixedRegion 决定语义） */
  onToggleRegion: () => void;
  onReselect: () => void;
  onInsertToEditor: () => void;
}

export function ResultActions({
  innerRef,
  left,
  top,
  attach,
  sensitiveKind,
  aiOk,
  hasFixedRegion,
  regionSaved,
  editorTarget,
  onCopyImage,
  onSaveToGallery,
  onPinImage,
  onOpenAi,
  onTranslate,
  onOpenChains,
  onToggleRegion,
  onReselect,
  onInsertToEditor,
}: Props) {
  return (
    <div
      ref={innerRef}
      className={`act-panel${attach === "inside" ? " inside" : ""}`}
      style={{ left, top }}
    >
      <div className="act-head">
        <span className="dot" /> 截图完成 · 选择出口
      </div>
      {sensitiveKind && (
        <div
          style={{
            padding: "6px 12px",
            fontSize: 11,
            lineHeight: 1.5,
            color: "var(--danger, #F87171)",
            background: "color-mix(in srgb, var(--danger, #F87171) 12%, transparent)",
            borderBottom: "1px solid color-mix(in srgb, var(--danger, #F87171) 25%, transparent)",
          }}
        >
          ⚠️ 检测到疑似敏感内容（{sensitiveKind}），AI / 云端出口已拦截，需确认后才发送
        </div>
      )}
      {/* 分三组：9 行平铺时扫视没有落点。不删行——工具栏平铺的三个出口只是多给一条路，
          用户可能从「更多」进来后再选复制，那些行仍然必须在。 */}
      <div className="act-group">图片</div>
      <div className="act-row" onClick={onCopyImage}>
        <span className="ic">⬡</span>
        <span>
          <div className="lbl">复制图片</div>
          <div className="sub">写入剪贴板历史</div>
        </span>
        <span className="k">Ctrl+C</span>
      </div>
      <div className="act-row" onClick={onSaveToGallery}>
        <span className="ic">⬇</span>
        <span>
          <div className="lbl">保存到图库</div>
          <div className="sub">另存为图片文件</div>
        </span>
        <span className="k">Ctrl+S</span>
      </div>
      <div className="act-row pin" onClick={onPinImage}>
        <span className="ic">📌</span>
        <span>
          <div className="lbl">贴图置顶</div>
          <div className="sub">钉在屏幕上</div>
        </span>
      </div>
      <div className="act-group">文字</div>
      {/* 规则 16：这两项必然走云端，AI 未启用时不渲染（零可见） */}
      {aiOk && (
        <div className="act-row ai" onClick={onOpenAi}>
          <span className="ic">AI</span>
          <span>
            <div className="lbl">AI 处理</div>
            <div className="sub">解释 / 翻译 / 总结</div>
          </span>
        </div>
      )}
      {aiOk && (
        <div className="act-row ai" onClick={onTranslate}>
          <span className="ic">译</span>
          <span>
            <div className="lbl">翻译</div>
            <div className="sub">识别文字翻译成中文</div>
          </span>
          <span className="k">⚡</span>
        </div>
      )}
      <div className="act-row chain" onClick={onOpenChains}>
        <span className="ic">⚡</span>
        <span>
          <div className="lbl">送动作链</div>
          <div className="sub">对识别文字跑自定义链</div>
        </span>
      </div>
      <div className="act-group">其它</div>
      {/* 固定区域（从 select 态移来）：低频操作，不占工具栏横向空间。
          已有固定区域时变为「清除」，给它一个能被发现的出口（否则只能靠右键回退）。 */}
      <div className="act-row" onClick={onToggleRegion}>
        <span className="ic">🔒</span>
        <span>
          <div className="lbl">
            {hasFixedRegion ? "清除固定区域" : regionSaved ? "✓ 已记住此区域" : "记住为固定区域"}
          </div>
          <div className="sub">
            {hasFixedRegion ? "恢复自动吸附" : "下次截图直接用这块区域"}
          </div>
        </span>
      </div>
      <div className="act-row" onClick={onReselect}>
        <span className="ic">↺</span>
        <span>
          <div className="lbl">重新截图</div>
          <div className="sub">重选区域</div>
        </span>
      </div>
      {/* 截图插入当前编辑文档（编辑器打开时才显示） */}
      {editorTarget && (
        <div
          className="act-row"
          style={{
            border: "1px solid rgba(34,211,238,0.45)",
            background: "rgba(34,211,238,0.07)",
          }}
          onClick={onInsertToEditor}
        >
          <span className="ic">📝</span>
          <span>
            <div className="lbl">插入到当前文档</div>
            <div className="sub">{editorTarget.split(/[\\/]/).pop()}</div>
          </span>
          <span className="k">Ctrl+Enter</span>
        </div>
      )}
    </div>
  );
}
