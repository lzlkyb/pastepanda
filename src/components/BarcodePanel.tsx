/**
 * BarcodePanel — 预览弹窗的二维码/条码结果抽屉（设计稿②，位于 OCR 抽屉之上）。
 *
 * 结构与折叠纪律复用 OCR 抽屉的样式类（同一套视觉语言）：
 * - 无码 → 整块不渲染（零可见）；解出码 → 自动展开一次（对齐 OCR L69 现行为）；
 * - 每条目：码制标签（QR=indigo / 一维码=cyan）+ mono 内容 + 复制 / ↗打开链接（仅 URL）；
 * - 底部：复制全部（按行拼接）+ 每个码存为新卡片（纯本地 prependItem）；
 * - 悬停条目 → onHover(index) 回调，图上标出码位（青色虚线框，父级渲染）。
 */
import { useEffect, useRef, useState } from "react";
import { useToast } from "@/components/Toast";
import { useAppStore, type HistoryItem } from "@/stores/appStore";
import {
  barcodeFormatLabel,
  copyToClipboard,
  isHttpUrl,
  isQrBarcodeFormat,
  joinBarcodeTexts,
  type BarcodeHit,
} from "@/lib/utils";
import styles from "./CardList.module.css";

export interface BarcodePanelProps {
  hits: BarcodeHit[];
  /** 悬停某条目时通知父级在图上画出对应码位框；null = 离开 */
  onHover: (index: number | null) => void;
}

export function BarcodePanel({ hits, onHover }: BarcodePanelProps) {
  const { toast } = useToast();
  const [open, setOpen] = useState(false);
  const [copiedKey, setCopiedKey] = useState<string | null>(null);
  const autoOpenedRef = useRef(false);

  // 解出码自动展开一次（与 OCR「识别完成自动展开一次」同纪律；收起后不再强开）
  useEffect(() => {
    if (hits.length > 0 && !autoOpenedRef.current) {
      autoOpenedRef.current = true;
      setOpen(true);
    }
    if (hits.length === 0) autoOpenedRef.current = false;
  }, [hits.length]);

  if (hits.length === 0) return null;

  const flashCopied = (key: string) => {
    setCopiedKey(key);
    setTimeout(() => setCopiedKey((k) => (k === key ? null : k)), 1500);
  };

  const handleCopyOne = async (hit: BarcodeHit, i: number) => {
    const ok = await copyToClipboard(hit.text);
    if (ok) flashCopied(`c${i}`);
    else toast("复制失败", "error");
  };

  const handleCopyAll = async () => {
    const ok = await copyToClipboard(joinBarcodeTexts(hits));
    if (ok) flashCopied("all");
    else toast("复制失败", "error");
  };

  const handleOpenUrl = async (hit: BarcodeHit) => {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl(hit.text.trim());
    } catch {
      toast("打开失败", "error");
    }
  };

  /** 每个码存为新卡片：与 OCR「存为卡片」同款（纯本地、零出网）。 */
  const handleSaveAllAsCards = () => {
    const store = useAppStore.getState();
    const items: HistoryItem[] = hits.map((h) => ({
      id: crypto.randomUUID(),
      text: h.text,
      time: new Date().toISOString(),
      type: "text" as const,
      content: "",
      pinned: false,
      source: "条码",
      workspace: store.config.current_workspace,
    }));
    if (items.length === 0) return;
    // prependItem 单条接口：多码逆序逐条插入，最终顺序与抽屉里一致
    for (const it of items.slice().reverse()) store.prependItem(it);
    toast(`已存为 ${items.length} 张卡片`, "success");
  };

  return (
    <div className={`${styles.ocrFullTextPanel}${open ? ' ' + styles.ocrDrawerOpen : ''}`}>
      <button
        type="button"
        className={styles.ocrDrawerHead}
        onClick={() => setOpen((v) => !v)}
        title={open ? "收起码结果" : "展开码结果"}
        onMouseLeave={() => onHover(null)}
      >
        <span className={styles.codeHeadGlyph}>▦</span>
        <span className={styles.ocrDrawerTitle}>二维码 / 条形码</span>
        <span className={styles.ocrDrawerCount}>{hits.length} 个码</span>
        <span
          className={`${styles.ocrDrawerChev} ${styles.codeHeadChev}${open ? ' ' + styles.codeChevOpen : ''}`}
        >▾</span>
      </button>

      {open && (
        <div className={styles.ocrDrawerBody}>
          {hits.map((hit, i) => (
            <div
              key={i}
              className={styles.codeItem}
              onMouseEnter={() => onHover(i)}
            >
              <div className={styles.codeMeta}>
                <span className={`${styles.codeFmtTag}${isQrBarcodeFormat(hit.format) ? '' : ' ' + styles.codeFmtTagOned}`}>
                  {barcodeFormatLabel(hit.format)}
                </span>
                <span className={styles.codeHint}>悬停 → 图上标出码位</span>
              </div>
              <div className={styles.codeText} title={hit.text}>{hit.text}</div>
              <div className={styles.codeActs}>
                <button
                  type="button"
                  className={`${styles.codeActBtn} ${styles.codeActBtnPrimary}`}
                  onClick={() => void handleCopyOne(hit, i)}
                >
                  {copiedKey === `c${i}` ? "✓ 已复制" : "📋 复制"}
                </button>
                {isHttpUrl(hit.text) ? (
                  <button type="button" className={styles.codeActBtn} onClick={() => void handleOpenUrl(hit)}>
                    ↗ 打开链接
                  </button>
                ) : (
                  <button type="button" className={styles.codeActBtn} disabled title="仅 URL 内容可打开">
                    ↗ 打开链接
                  </button>
                )}
              </div>
            </div>
          ))}
          <div className={styles.codeSaveRow}>
            <button type="button" className={styles.codeActBtn} onClick={() => void handleCopyAll()}>
              {copiedKey === "all" ? "✓ 已复制" : "📋 复制全部（多码按行拼接）"}
            </button>
            <button
              type="button"
              className={styles.codeActBtn}
              title="把每个码的内容各存为一条新卡片（纯本地）"
              onClick={handleSaveAllAsCards}
            >
              💾 每个码存为新卡片
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
