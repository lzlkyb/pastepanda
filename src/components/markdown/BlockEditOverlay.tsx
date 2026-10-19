/**
 * BlockEditOverlay —— 预览态「块级就地编辑」浮层（MarkCopy 思路）：
 * 双击预览里任意顶层块 → 浮层里编辑这一块的**原始 Markdown 源码** → 保存写回。
 *
 * 为什么不做表格逐格编辑：等价于重写一个表格网格（列宽 / 合并 / 对齐 / 增删行列），
 * 成本远高于收益；块级编辑一次覆盖段落、标题、列表、表格、引用、代码块所有类型，
 * 且写回是一次 dispatch = 一步撤销，Ctrl+Z 链路与手改源码完全同源。
 *
 * 保存失败（源码在浮层打开期间被改过，写回侧 expectRaw 校验不过）时**不关闭**，
 * 留在浮层里提示重试 —— 用户编辑的内容不丢。
 */
import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { useDialogEscape } from "@/hooks/useDialogEscape";
import styles from "./BlockEditOverlay.module.css";

interface BlockEditOverlayProps {
  /** 块序号（1 起，仅标题展示） */
  blockNo: number;
  /** 打开浮层时那块的全部源码（也是写回侧的 expectRaw） */
  raw: string;
  /** 写回。true = 已写入并重渲染；false = 源码已变化被拒绝 */
  onSave: (newRaw: string) => boolean;
  onClose: () => void;
}

export function BlockEditOverlay({ blockNo, raw, onSave, onClose }: BlockEditOverlayProps) {
  const [value, setValue] = useState(raw);
  const [stale, setStale] = useState(false);
  const areaRef = useRef<HTMLTextAreaElement>(null);

  // 统一 Esc 处理（捕获期 + 让路确认框 + 输入法合成保护，规则 #11）
  useDialogEscape(onClose);

  useEffect(() => {
    areaRef.current?.focus();
  }, []);

  const save = () => {
    // 内容没改就直接关，不空写一次 dispatch（省一次重渲染 + 一条撤销记录）
    if (value === raw) {
      onClose();
      return;
    }
    if (onSave(value)) onClose();
    else setStale(true);
  };

  return createPortal(
    <div className={styles.root}>
      <div className={styles.panel} role="dialog" aria-label={`编辑块 ${blockNo} 源码`}>
        <div className={styles.head}>
          <span className={styles.title}>编辑块 {blockNo} 源码</span>
          <span className={styles.hint}>Ctrl+Enter 保存 · Esc 取消</span>
        </div>
        <textarea
          ref={areaRef}
          className={styles.area}
          value={value}
          spellCheck={false}
          onChange={(e) => {
            setValue(e.target.value);
            if (stale) setStale(false);
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && (e.ctrlKey || e.metaKey)) {
              e.preventDefault();
              save();
            }
          }}
        />
        {stale && (
          <div className={styles.stale}>源码已被修改（编辑区有新输入或勾选有变化），保存被拒绝。请重试或复制内容后关闭。</div>
        )}
        <div className={styles.foot}>
          <button type="button" className={styles.btn} onClick={onClose}>
            取消
          </button>
          <button type="button" className={`${styles.btn} ${styles.primary}`} onClick={save}>
            保存
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
