/**
 * OCR 结果抽屉：识别过程/失败/空结果/逐行结果四态 + 二维码条 + 底部出口。
 *
 * 纯展示组件：打开链接、复制等副作用全部上提为回调——
 * 子组件不直接发 IPC，否则它就不可替换也不可测。
 */

import { QrCode } from "lucide-react";
import type { OcrResult } from "@/lib/api/images";

/** 与父组件的 ocrStatus 同一套取值。idle（还没开始跑）按「正在识别」展示。 */
type OcrStatus = "idle" | "running" | "done" | "empty" | "failed";

interface Props {
  /** 位置与高度上限（父组件用 layoutSidePanel 算好）。
   *  旧实现写在 CSS 里钉死屏幕右上角，与选区无关，会压住选区内容。 */
  left: number;
  top: number;
  maxHeight: number;
  /** 贴在哪一侧；inside 表示实在无处可放、只能盖在选区上（样式会淡一点） */
  side: "right" | "left" | "inside";
  status: OcrStatus;
  /** 识别结果。running / failed / empty 态下是 null，所以下游取值全部要判空。 */
  ocr: OcrResult | null;
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
  /** 失败态「重试识别」 */
  onRetry: () => void;
  onClose: () => void;
}

export function OcrDrawer({
  left,
  top,
  maxHeight,
  side,
  status,
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
  onRetry,
  onClose,
}: Props) {
  // idle 只存在于「预截屏刚拿到、模型还没启动」的极短窗口，对用户就是「还没结果」，
  // 与 running 共用一张卡，不为它单独造第四种说法。
  const st: OcrStatus = status === "idle" ? "running" : status;
  const title =
    st === "done"
      ? `OCR 识别 · ${ocr?.lines.length ?? 0} 行`
      : st === "failed"
        ? "OCR 识别 · 失败"
        : st === "empty"
          ? "OCR 识别 · 0 行"
          : "OCR 识别";

  return (
    <div className={`ocr-drawer${side === "inside" ? " inside" : ""}`} style={{ left, top, maxHeight }}>
      <div className="ocr-head">
        <span>{title}</span>
        <span className="sp" />
        {st === "done" && (
          <button className={`copy-all${copiedAll ? " done" : ""}`} onClick={onCopyAll}>
            {copiedAll ? "已复制 ✓" : "复制全文"}
          </button>
        )}
      </div>
      {/* §2：识别过程不再被压成一句「未从图片识别到文字」。
          旧实现 running / failed / 真空三种原因共用同一句文案，且失败没有重试入口
          ——「图里确实没字」和「引擎根本没返回」是两件必须让用户分开处理的事。 */}
      {st === "running" && (
        <div className="ocr-state">
          <span className="t">
            <span className="ocr-spin" /> 正在识别文字…
          </span>
          <span className="d">首次使用需加载模型，可能比后续几次慢</span>
        </div>
      )}
      {st === "failed" && (
        <div className="ocr-state err">
          <span className="t">文字识别失败</span>
          <span className="d">
            OCR 引擎没有返回结果（多为首次加载超时）。图片本身已经截好，复制 / 保存 / 贴图不受影响。
          </span>
          <button type="button" className="retry" onClick={onRetry}>
            重试识别
          </button>
        </div>
      )}
      {st === "empty" && (
        <div className="ocr-state">
          <span className="t">这张图里没有文字</span>
          <span className="d">引擎正常返回，内容为空。可以试试重新框一块更清晰的区域。</span>
        </div>
      )}
      {st === "done" && qr && (
        <div className="qr-bar">
          <span className="qr-ic">
            <QrCode size={14} />
          </span>
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
      {st === "done" && (
        <div className="ocr-body">
          {/* U7：每一行都是一个「复制这行」按钮，原先是 `<div onClick>`——
             识别出来的整列文字键盘一行也点不到。 */}
          {ocr?.lines.map((line, i) => (
            <button
              key={i}
              type="button"
              className={`ocr-row${copiedRow === i ? " copied" : ""}`}
              onClick={() => onCopyRow(i)}
            >
              <span className="n">{i + 1}</span>
              <span className="tx">{line.text}</span>
            </button>
          ))}
        </div>
      )}
      <div className="ocr-foot">
        {/* 「复制全部」删了：脚部与头部一直是同一件事的两个入口（审计 §4），
            而 doing 以外的态里头部那颗已经不渲染，留着它反而只剩这一个说法。 */}
        {st === "done" && (
          <>
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
          </>
        )}
        {/* 非 done 态只剩这一个出口：openOcrEdit / openTable 在没有结果时是
            `if (!ocr) return`，摆出来就是一次静默失败（规则 15.3）。 */}
        <button className="fbtn" onClick={onClose}>
          关闭
        </button>
      </div>
    </div>
  );
}
