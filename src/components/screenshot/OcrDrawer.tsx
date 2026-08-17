/**
 * OCR 结果抽屉：逐行识别结果 + 二维码条 + 底部出口。
 *
 * 纯展示组件：打开链接、复制等副作用全部上提为回调——
 * 子组件不直接发 IPC，否则它就不可替换也不可测。
 */

import type { OcrResult } from "@/lib/api/images";

interface Props {
  /** 位置与高度上限（父组件用 layoutSidePanel 算好）。
   *  旧实现写在 CSS 里钉死屏幕右上角，与选区无关，会压住选区内容。 */
  left: number;
  top: number;
  maxHeight: number;
  /** 贴在哪一侧；inside 表示实在无处可放、只能盖在选区上（样式会淡一点） */
  side: "right" | "left" | "inside";
  ocr: OcrResult;
  /** 识别到的二维码内容（null = 未识别到） */
  qr: string | null;
  qrCopied: boolean;
  copiedAll: boolean;
  /** 刚复制过的行号（用于行内反馈） */
  copiedRow: number | null;
  /** AI 可用（规则 16：不可用时「AI 解释」零可见） */
  aiOk: boolean;
  onCopyAll: () => void;
  onCopyRow: (index: number) => void;
  onCopyQr: () => void;
  /** 二维码内容是 http(s) 时才会被调用 */
  onOpenQrUrl: () => void;
  onOpenOcrEdit: () => void;
  onOpenTable: () => void;
  onOpenAi: () => void;
  onOpenChains: () => void;
  onClose: () => void;
}

export function OcrDrawer({
  left,
  top,
  maxHeight,
  side,
  ocr,
  qr,
  qrCopied,
  copiedAll,
  copiedRow,
  aiOk,
  onCopyAll,
  onCopyRow,
  onCopyQr,
  onOpenQrUrl,
  onOpenOcrEdit,
  onOpenTable,
  onOpenAi,
  onOpenChains,
  onClose,
}: Props) {
  return (
    <div className={`ocr-drawer${side === "inside" ? " inside" : ""}`} style={{ left, top, maxHeight }}>
      <div className="ocr-head">
        <span>OCR 识别 · {ocr.lines.length} 行</span>
        <span className="sp" />
        <button className={`copy-all${copiedAll ? " done" : ""}`} onClick={onCopyAll}>
          {copiedAll ? "已复制 ✓" : "复制全文"}
        </button>
      </div>
      {qr && (
        <div className="qr-bar">
          <span className="qr-ic">▦</span>
          <span className="qr-tx" title={qr}>
            {qr.length > 48 ? qr.slice(0, 48) + "…" : qr}
          </span>
          <button className="qr-btn" onClick={onCopyQr}>
            {qrCopied ? "已复制 ✓" : "复制"}
          </button>
          {/^https?:\/\//i.test(qr) && (
            <button className="qr-btn" onClick={onOpenQrUrl}>
              打开
            </button>
          )}
        </div>
      )}
      <div className="ocr-body">
        {ocr.lines.length === 0 ? (
          <div style={{ fontSize: 11, color: "var(--text-muted)", padding: "6px 4px" }}>
            未从图片识别到文字
          </div>
        ) : (
          ocr.lines.map((line, i) => (
            <div
              key={i}
              className={`ocr-row${copiedRow === i ? " copied" : ""}`}
              onClick={() => onCopyRow(i)}
            >
              <span className="n">{i + 1}</span>
              <span className="tx">{line.text}</span>
            </div>
          ))
        )}
      </div>
      <div className="ocr-foot">
        <button className="fbtn" onClick={onCopyAll}>
          {copiedAll ? "已复制 ✓" : "复制全部"}
        </button>
        <button className="fbtn" onClick={onOpenOcrEdit}>
          编辑文本
        </button>
        <button className="fbtn" onClick={onOpenTable}>
          提取表格
        </button>
        {/* 规则 16：AI 未启用时必须零可见——不能渲染出来再靠函数里 early return，
            那是「点了没反应」的静默失败（又踩规则 15.3）。
            送动作链不跟 aiOk 走：纯本地链在 AI 关着时照样可用，细粒度控制放在弹层里。 */}
        {aiOk && (
          <button className="fbtn ai" onClick={onOpenAi}>
            AI 解释
          </button>
        )}
        <button className="fbtn chain" onClick={onOpenChains}>
          送动作链
        </button>
        <button className="fbtn" onClick={onClose}>
          完成
        </button>
      </div>
    </div>
  );
}
