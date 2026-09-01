/**
 * KbQaTurn.tsx —— 问答面板里的**一轮**（B2 #10b）。
 *
 * 从 `KbQaPanel` 抽出来的两个理由：
 * 1. 规则 #7（单文件 ≤300 行）；
 * 2. **引用 chip 的点击得知道是哪一轮的 refs**。在整个会话容器上做委托的话，
 *    `[1]` 就分不清是第一轮的第 1 篇还是第二轮的第 1 篇——而它们往往不是同一篇。
 *    每轮自己拿自己的 refs 做处理，这个错就不可能发生。
 */
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import { citationIndexFromHref, linkifyCitations, type QaRef } from "@/lib/notes/kbQa";
import styles from "./KbQaPanel.module.css";

export function KbQaTurn({
  question,
  answer,
  refs,
  cached,
  truncated,
  streaming,
  onOpenNote,
}: {
  question: string;
  answer: string;
  refs: QaRef[];
  cached?: boolean;
  truncated?: boolean;
  /** 流式进行中：给 MarkdownRenderer 上防抖，并显光标 */
  streaming?: boolean;
  onOpenNote: (noteId: string) => void;
}) {
  /**
   * 引用 chip 的点击。事件委托到本轮的回答容器上：
   * `MarkdownRenderer` 把 `[1](#kbqa-ref-1)` 渲染成了普通 anchor，这里拦下。
   * **必须 preventDefault**：否则 hash 导航会改 URL。
   */
  const handleClick = (e: React.MouseEvent<HTMLDivElement>) => {
    const a = (e.target as HTMLElement).closest("a");
    if (!a) return;
    const n = citationIndexFromHref(a.getAttribute("href"));
    if (n === null) return; // 普通链接，不拦
    e.preventDefault();
    const ref = refs[n - 1];
    if (ref) onOpenNote(ref.id);
  };

  return (
    <div className={styles.turn}>
      {/* 问题行。多轮下不写它就分不清哪个答对应哪个问 */}
      <div className={styles.qline}>{question}</div>

      {/* 这里不是把 div 当按钮：可交互元素是里面真正的 <a>（自带键盘可达与回车触发），
          div 只是委托点——因为 anchor 是 Markdown 渲染出来的，没地方挂 onClick */}
      <div className={styles.answer} onClick={handleClick}>
        <MarkdownRenderer
          text={linkifyCitations(answer, refs.length)}
          compact
          /* clamp 是「裁到 120px 且不可滚」——正是本次要消灭的毛病，永远不传 */
          clamp={false}
          /* 流式下防抖：每个 chunk 都改 text，而它每次改都重解析整篇 + 重建 DOM。
             一次回答几百个 chunk = 几百次全量重渲染（规则 #8）。
             完成后不防抖：那时只渲染一次，再延迟只是白闪一下 */
          debounceMs={streaming ? 80 : 0}
          /* 回答是模型生成的文本，没有所属目录，相对图片路径本来就无法解 */
          baseDir={null}
        />
        {streaming && <span className={styles.caret} aria-hidden="true" />}
      </div>

      {refs.length > 0 && (
        <div className={styles.refs}>
          <span className={styles.refsLabel}>参考：</span>
          {refs.map((r, i) => (
            <button
              key={r.id}
              type="button"
              className={styles.ref}
              onClick={() => onOpenNote(r.id)}
              title="打开这篇笔记"
            >
              {i + 1} {r.title}
              {/* 「已截断」不能静默（规则 #15.3）：用户得知道模型只看了这篇的开头 */}
              {r.truncated && <span className={styles.clip}>（已截断）</span>}
            </button>
          ))}
          {cached && <span className={styles.badge}>缓存</span>}
        </div>
      )}

      {truncated && (
        <div className={styles.hint}>⚠ 回答撞上长度上限，已被截断。</div>
      )}
    </div>
  );
}
