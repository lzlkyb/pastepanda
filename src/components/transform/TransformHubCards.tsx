import { ArrowUpRight, Loader2, RotateCw } from "lucide-react";
import type { ScoredTransform } from "@/lib/transforms";
import { isPinnedAction } from "@/lib/recommend";
import type { useTransformHub } from "@/hooks/useTransformHub";
import { MelodyEmpty } from "@/components/MelodyEmpty";
import { TransformCard } from "./TransformCard";
import { specsFor } from "./transformOptions";
import styles from "../TransformHub.module.css";

export type TransformHubState = ReturnType<typeof useTransformHub>;
export function TransformHubCards({ hub }: { hub: TransformHubState }) {
  const { itemHtml, itemUserTags, sourceText, optsFor, setOpt, ctx, copiedId, copyOutput,
    pasteOutput, handleDismiss, handleTogglePin, actionRefs, activeActionId, setShowCodec,
    isImage, override, ocrLoading, ocrText, setOcrText, ocrError, runOcr,
    scored, pinned, recommended, others, manual } = hub;
  const renderCard = ({ transform: t, score, reason }: ScoredTransform) => (
    <div
      key={t.id}
      ref={(el) => {
        if (el) actionRefs.current.set(t.id, el);
        else actionRefs.current.delete(t.id);
      }}
      className={activeActionId === t.id ? styles.cardActiveWrap : undefined}
    >
      <TransformCard
        t={t}
        score={score}
        text={sourceText}
        html={itemHtml}
        userTags={itemUserTags}
        opts={optsFor(t)}
        specs={specsFor(t, ctx)}
        copied={copiedId === t.id}
        onSetOpt={(k, v) => setOpt(t.id, k, v)}
        onCopy={(output, meta) => void copyOutput(t, output, meta)}
        onPaste={(output) => void pasteOutput(t, output)}
        contentType={ctx.contentType}
        reason={reason}
        onDismiss={(id) => void handleDismiss(id)}
        pinned={isPinnedAction(t.id)}
        onTogglePin={(id, next) => void handleTogglePin(id, next)}
      />
      {t.workbench === "codec" && (
        <button className={styles.workbenchLink} onClick={() => setShowCodec(true)}>
          在编解码工作台中继续处理 <ArrowUpRight size={12} />
        </button>
      )}
    </div>
  );

  return (
              <div className={styles.cards}>
                {/* 图片：把本地识别结果摆出来并允许修改。
                    让用户先看一眼再决定要不要发给模型——识别错了就没必要花这个钱。 */}
                {isImage && !override && (
                  <div className={styles.ocrBox}>
                    <div className={styles.ocrHead}>
                      {ocrLoading ? (
                        <>
                          <Loader2 size={12} className="spin" /> 本地识别中…
                        </>
                      ) : (
                        <>本地识别结果（可修改）</>
                      )}
                      <button
                        className={styles.ocrRetry}
                        disabled={ocrLoading}
                        onClick={() => void runOcr()}
                      >
                        <RotateCw size={11} /> 重新识别
                      </button>
                    </div>
                    {!ocrLoading && (
                      <textarea
                        className={styles.ocrText}
                        value={ocrText}
                        placeholder="识别不出来时可以自己敲"
                        onChange={(e) => setOcrText(e.target.value)}
                      />
                    )}
                    {ocrError && <div className={styles.ocrErr}>{ocrError}</div>}
                    <div className={styles.ocrNote}>
                      图片不会被发送，只有上面这段文字会交给变换。
                    </div>
                  </div>
                )}

                {scored.length === 0 && !manual && !ocrLoading && (
                  <div className={styles.empty}>
                    <MelodyEmpty size={64} />
                    {isImage && !sourceText ? "没有可用的文字，先试试重新识别或手动输入" : "暂时没有明确的推荐，可在下方查看全部变换"}
                  </div>
                )}
                {manual && <>
                  <div className={styles.sectionLabel}>你指定的操作</div>
                  {renderCard(manual)}
                </>}
                {/* 常用（置顶）排最前。没置顶时整组不渲染，不留空标题。 */}
                {pinned.some(s => s.transform.id !== manual?.transform.id) && (
                  <>
                    <div className={styles.sectionLabel}>常用</div>
                    {pinned.filter(s => s.transform.id !== manual?.transform.id).map(renderCard)}
                  </>
                )}
                {recommended.some(s => s.transform.id !== manual?.transform.id) && (
                  <>
                    <div className={styles.sectionLabel}>推荐</div>
                    {recommended.filter(s => s.transform.id !== manual?.transform.id).map(renderCard)}
                  </>
                )}
                {others.some(s => s.transform.id !== manual?.transform.id) && (
                  <>
                    <div className={styles.sectionLabel}>可选</div>
                    {others.filter(s => s.transform.id !== manual?.transform.id).map(renderCard)}
                  </>
                )}
              </div>
  );
}
