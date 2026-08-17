/**
 * 两个文本类弹层：表格提取结果、OCR 文本编辑。
 *
 * 两者结构几乎一样（头 + 说明 + textarea + 底部两个按钮），放在同一文件里便于对照；
 * 都是纯展示组件，不持状态、不发 IPC。
 */

interface TableProps {
  csv: string;
  /** 识别失败的原因（非空时只显示错误态） */
  err: string | null;
  copied: boolean;
  onCopy: () => void;
  onClose: () => void;
}

export function TablePopover({ csv, err, copied, onCopy, onClose }: TableProps) {
  return (
    <div className="pop-layer">
      <div className="pop-head">
        <span>表格识别 · OCR 几何提取</span>
        <span className="sp" />
        <button className="xbtn" onClick={onClose}>
          ✕
        </button>
      </div>
      {err ? (
        <>
          <div className="pop-result err">{err}</div>
          <div className="pop-foot">
            <button className="fb" onClick={onClose}>
              关闭
            </button>
          </div>
        </>
      ) : (
        <>
          <div style={{ padding: "4px 12px 0", fontSize: 10, color: "var(--text-muted)" }}>
            基于 OCR 坐标的几何识别：整齐表格效果好，合并单元格可能失真
          </div>
          <textarea readOnly className="table-out" value={csv} spellCheck={false} />
          <div className="pop-foot">
            <button className="fb primary" onClick={onCopy}>
              {copied ? "已复制 ✓" : "复制 CSV"}
            </button>
            <button className="fb" onClick={onClose}>
              关闭
            </button>
          </div>
        </>
      )}
    </div>
  );
}

interface OcrEditProps {
  text: string;
  onChange: (v: string) => void;
  copied: boolean;
  onCopy: () => void;
  onClose: () => void;
}

export function OcrEditPopover({ text, onChange, copied, onCopy, onClose }: OcrEditProps) {
  return (
    <div className="pop-layer">
      <div className="pop-head">
        <span>编辑识别文本</span>
        <span className="sp" />
        <button className="xbtn" onClick={onClose}>
          ✕
        </button>
      </div>
      <div style={{ padding: "4px 12px 0", fontSize: 10, color: "var(--text-muted)" }}>
        修正 OCR 错字后复制（微信 OCR 面板同款）
      </div>
      <textarea
        autoFocus
        className="ocr-edit-out"
        value={text}
        onChange={(e) => onChange(e.target.value)}
        spellCheck={false}
      />
      <div className="pop-foot">
        <button className="fb primary" onClick={onCopy}>
          {copied ? "已复制 ✓" : "复制修改后的文本"}
        </button>
        <button className="fb" onClick={onClose}>
          关闭
        </button>
      </div>
    </div>
  );
}
