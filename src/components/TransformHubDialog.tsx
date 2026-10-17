/** 按需推荐枢纽；行为状态与卡片流分开维护，避免弹窗继续膨胀。 */
import { motion, AnimatePresence } from "framer-motion";
import { X, Sparkles, Workflow } from "lucide-react";
import { AiMark } from "@/components/ai/AiMark";
import { useDialogStore } from "@/stores/dialogStore";
import { useDialogAnim } from "@/lib/dialogMotion";
import { FocusTrap } from "@/components/FocusTrap";
import { CodecEditor } from "@/components/editors/CodecEditor";
import { QREditor } from "@/components/editors/QREditor";
import { NlCommandBar } from "@/components/NlCommandBar";
import { useTransformHub } from "@/hooks/useTransformHub";
import { TransformHubCards } from "./transform/TransformHubCards";
import { TransformHubTools } from "./transform/TransformHubTools";
import styles from "./TransformHub.module.css";

export function TransformHubDialog() {
  const hub = useTransformHub();
  const { open, suspended, aiAvailable, item, scored, close, handleNlApply, sourceText,
    showCodec, setShowCodec, showQr, setShowQr } = hub;
  const anim = useDialogAnim();
  // 常挂载，open=false 时由 AnimatePresence 驱动退场后再卸载
  return (
    <>
    <AnimatePresence>
      {open && item && (
        <motion.div {...anim.backdrop} className={`dialog-backdrop ${suspended ? styles.suspended : ""}`} aria-hidden={suspended || undefined} onClick={close}>
          <FocusTrap active={!suspended}>
            <motion.div
              {...anim.panel}
              className={`dialog-box w460 ${styles.hub}`}
              onClick={(e) => e.stopPropagation()}
            >
              <div className="dialog-header">
                <span className={styles.headerIcon}><Sparkles size={16} /></span>
                <h2 className="dialog-title">变换为…</h2>
                <span className={styles.headerSub}>{scored.length} 个可用变换</span>
                {/* hover 背景交给 dialog.css 的 .dialog-close:hover；
                    inline style 优先级更高，会把 blossom 主题的定制 hover 压掉 */}
                <button onClick={close} className="dialog-close" aria-label="关闭">
                  <X size={16} />
                </button>
              </div>

              {/* v6.3 自然语言动作：一句话定位到对应变换 */}
              <NlCommandBar onResult={handleNlApply} />

              {/* 链入口：两者曾经是 dialog-header 里的两个小按钮，主窗口 480px 下
                  那行只有 408px 可用而内容已 ~406px，「编链中…」态直接把关闭按钮顶到弹窗外。
                  下移到独立一行后拿到整行 420px，顺便把原本只在 title 里的说明携到了可见处。
                  位置在 NlCommandBar 与卡片区之间：三者都回答“怎么处理这段内容”，
                  从一句话 → 一条链 → 单个变换，粒度递减。 */}
              <div className={styles.chainRow}>
                <button
                  className={styles.chainTile}
                  onClick={() => useDialogStore.getState().openChain(sourceText)}
                >
                  <span className={styles.chainTileIcon}><Workflow size={15} /></span>
                  <span className={styles.chainTileText}>
                    <span className={styles.chainTileName}>用现成流程</span>
                    <span className={styles.chainTileDesc}>先看步骤，再运行</span>
                  </span>
                </button>
                {/* 让 AI 根据当前内容编一条链（手动触发，编完仍需确认才跑） */}
                {aiAvailable && <button
                  className={styles.chainTile}
                  onClick={() => useDialogStore.getState().openChain(sourceText, undefined, undefined, "ai")}
                >
                  <span className={styles.chainTileIcon} data-ai="1"><Sparkles size={15} /></span>
                  <span className={styles.chainTileText}>
                    <span className={styles.chainTileName}><AiMark shape="text" text="让 AI 设计流程" /></span>
                    <span className={styles.chainTileDesc}>说出目标，确认后运行</span>
                  </span>
                </button>}
              </div>

              <TransformHubCards hub={hub} />
              <TransformHubTools onSelect={hub.selectTransform}
                onQr={() => setShowQr(true)} onCodec={() => setShowCodec(true)} />
            </motion.div>
          </FocusTrap>
        </motion.div>
      )}
    </AnimatePresence>
    {open && item && showCodec && (
      <CodecEditor initialText={sourceText} onClose={() => setShowCodec(false)} />
    )}
    {open && item && showQr && (
      <QREditor initialText={sourceText} onClose={() => setShowQr(false)} />
    )}
    </>
  );
}
