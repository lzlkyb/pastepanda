import { useState, useMemo } from "react";
import { Clock, Copy, Hash, Eraser, Calculator, Sigma } from "lucide-react";
import { useEditorCore } from "./useEditorCore";
import { CodeTextArea } from "./CodeTextArea";
import { MetaBar, TransformToolbar, OriginalDiff, ToolBtn } from "./editorBits";
import {
  parseLeadingNumber, formatGrouped, timestampInfo, tzLabel, baseInfo, bytesInfo,
  groupNumbersInText, stripNumberCommas, truncateNumbersInText,
} from "@/lib/numberToolbox";
import { useToast } from "@/components/Toast";
import type { EditorProps } from "@/lib/editorRegistry";

/**
 * 数字专用编辑器（B 方案 A · 速览卡片）：
 * - 上方只读拆解卡片：千分位 / 时间戳（自动识别秒级·毫秒级）/ 进制（HEX·OCT·BIN）/ 字节单位；
 * - 多值文本解析首个数值并标注总数；无时间戳含义时该行自动隐藏；
 * - 动作行：插入当前时间戳 / 复制十六进制 / 复制日期；
 * - 下方保留可编辑文本区 + 数字专用变换（千分位/去逗号/取整）。
 */
export function NumberEditor({ item, registerActions }: EditorProps) {
  const { text, pushHistory, undo, redo, originalText, isModified } = useEditorCore(item, registerActions);
  const [showOriginal, setShowOriginal] = useState(false);
  const { toast } = useToast();

  const parsed = useMemo(() => parseLeadingNumber(text), [text]);
  const ts = useMemo(() => (parsed ? timestampInfo(parsed.value) : null), [parsed]);
  const bases = useMemo(() => (parsed ? baseInfo(parsed.value) : null), [parsed]);
  const bytes = useMemo(() => (parsed ? bytesInfo(parsed.value) : null), [parsed]);

  const transform = (fn: (s: string) => string) => pushHistory(fn(text));

  const copyValue = async (value: string, label: string) => {
    try {
      await navigator.clipboard.writeText(value);
      toast(`已复制${label}`, "success");
    } catch {
      toast("复制失败", "error");
    }
  };

  const insertNow = () => pushHistory(String(Math.floor(Date.now() / 1000)));

  return (
    <>
      <MetaBar
        lineCount={text.split("\n").length}
        charCount={text.length}
        isModified={isModified}
        badge="🔢 数字"
        status={
          parsed ? (
            <span className="link-valid-badge">✓ {parsed.isInteger ? "整数" : "小数"}</span>
          ) : (
            <span className="link-invalid-badge">✗ 无数值</span>
          )
        }
      />

      {parsed ? (
        <div className="url-struct">
          {/* 数值（千分位） */}
          <div className="url-row">
            <span className="url-label">数值</span>
            <span className="num-big">{formatGrouped(parsed.value)}</span>
            <span className="num-sub">
              十进制 · 千分位{parsed.tokenCount > 1 ? ` · 首个（共 ${parsed.tokenCount} 个）` : ""}
            </span>
          </div>

          {/* 时间戳解读（超范围自动隐藏） */}
          {ts && (
            <div className="url-row">
              <span className="url-label">时间</span>
              <span className="num-chip num-chip-time">{ts.local}</span>
              <span className="num-sub">{tzLabel()} · 自动识别{ts.unit === "s" ? "秒" : "毫秒"}级</span>
            </div>
          )}

          {/* 进制换算 */}
          {bases && (
            <>
              <div className="url-row">
                <span className="url-label">进制</span>
                <span className="num-chip"><b>HEX</b>{bases.hex}</span>
                <span className="num-chip"><b>OCT</b>{bases.oct}</span>
              </div>
              <div className="url-row">
                <span className="url-label"></span>
                <span className="num-chip"><b>BIN</b>{bases.bin}</span>
              </div>
            </>
          )}

          {/* 字节单位 */}
          {bytes && (
            <div className="url-row">
              <span className="url-label">字节</span>
              <span className="num-chip num-chip-warm">≈ {bytes.best}</span>
              {bytes.detail && <span className="num-sub">{bytes.detail}</span>}
            </div>
          )}
        </div>
      ) : (
        <div className="url-invalid-note">
          <Sigma size={13} />
          未识别到数值 — 编辑下方文本后自动恢复拆解
        </div>
      )}

      {/* 动作行 */}
      <div className="editor-actions">
        <ToolBtn accent icon={<Clock size={13} />} label="插入当前时间戳" onClick={insertNow} />
        {bases && <ToolBtn icon={<Copy size={13} />} label="复制十六进制" onClick={() => copyValue(bases.hex, "十六进制")} />}
        {ts && <ToolBtn icon={<Copy size={13} />} label="复制日期" onClick={() => copyValue(ts.local, "日期")} />}
      </div>

      <CodeTextArea value={text} onChange={pushHistory} textareaId="edit-code-textarea" />

      <TransformToolbar
        text={text}
        transform={transform}
        undo={undo}
        redo={redo}
        isModified={isModified}
        showOriginal={showOriginal}
        onToggleOriginal={() => setShowOriginal(!showOriginal)}
        isHtmlContent={false}
        prepend={
          <>
            <ToolBtn icon={<Hash size={13} />} label="千分位" onClick={() => transform(groupNumbersInText)} />
            <ToolBtn icon={<Eraser size={13} />} label="去逗号" onClick={() => transform(stripNumberCommas)} />
            <ToolBtn icon={<Calculator size={13} />} label="取整" onClick={() => transform(truncateNumbersInText)} />
            <div className="tool-separator" />
          </>
        }
      />

      {showOriginal && isModified && <OriginalDiff originalText={originalText} />}
    </>
  );
}
