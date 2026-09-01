/**
 * 笔记弹窗的正文区：左编辑（CodeMirror）/ 右预览（Markdown）。
 *
 * 从 NoteDialog 拆出来的原因：弹窗外壳管的是标题/来源/保存/脏数据确认，
 * 这里管的是“文本怎么编”——两件事。合在一个文件里会直接碰规则 #7（单 tsx ≤300 行）。
 *
 * 复用 `useCodeMirrorEditor`（规划 §8.1 1️⃣ 抽出来的那个 hook），而不是再搭一套：
 * 它已经处理了主题切换、快捷键、hostRef 避坑（见 hook 头部的 9e401e6 说明）。
 *
 * 🔴 红线：不接 AI。正文只在本机内存 ↔ 本机 SQLite 之间走。
 */
import { useMemo } from "react";
import { markdownWithCode } from "@/components/editors/fullscreen/languages";
import { useCodeMirrorEditor } from "@/components/editors/useCodeMirrorEditor";
import { wikiLinkCompletion } from "./wikiLinkComplete";
import { mdTableKeymap } from "./mdTableKeymap";
import { noteList } from "@/lib/api";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";
import styles from "./NoteDialog.module.css";

export function NoteEditorPane({
  initialContent,
  content,
  isDark,
  onChange,
  onSave,
}: {
  /** 挂载时的初值。**变了也不会重建编辑器**（hook 的装配只跟 ready），
   *  所以换笔记时必须靠外层 key 重建本组件——NoteDialog 那边已经这么做了。 */
  initialContent: string;
  /** 当前文本（受控值），给预览用 */
  content: string;
  isDark: boolean;
  onChange: (next: string) => void;
  /** Ctrl+S：与底部「保存」同一条路 */
  onSave: () => void;
}) {
  /**
   * 语言与编辑增强。hook 要的是 `(ctx) => Extension`（Extension 可以是数组）。
   * 笔记不支持粘图片（没有 docDir，图无处存），所以不传 insertPastedImages。
   *
   * 三样都是 B1 #12：
   * ① `markdownWithCode` —— 围栏代码块高亮，与全屏编辑器同一套配置；
   * ② `mdTableKeymap` —— 装在 hook 的 `indentWithTab` **之前**（language 扩展先于基础键位入数组），
   *   不在表格里时它返回 false，Tab 照旧缩进；
   * ③ `wikiLinkCompletion` —— 仅提示不解析（D7）。
   */
  const language = useMemo(
    () => () => [
      markdownWithCode(),
      mdTableKeymap(),
      wikiLinkCompletion(async () => {
        // 只拉一次（缓存在 wikiLinkCompletion 里）。200 条封顶：
        // 候选最多展示 20 条，拉全库只是白花 IPC。
        const notes = await noteList({ limit: 200 });
        return notes.map((n) => n.title).filter(Boolean);
      }),
    ],
    [],
  );

  const { editorRef } = useCodeMirrorEditor({
    initialText: initialContent,
    ready: true,
    isDark,
    text: content,
    language,
    onDocChange: onChange,
    onSave,
  });

  return (
    <div className={styles.split}>
      <div className={styles.editPane} ref={editorRef} />
      <div className={styles.previewPane}>
        {/* debounce：边敲边重解 Markdown 在长笔记上会卡。120ms 跟 FullscreenEditor 同口径。

            ❗ **不要加 clamp**。compact 只是排版紧凑，clamp 才是限高 120px 且不可滚。
            两者曾经是同一个开关，结果笔记正文超过约 6 行就被静默截断——
            这里是「读全文」的场景，高度交给外层 .previewPane 的 overflow:auto 管。 */}
        <MarkdownRenderer text={content} debounceMs={120} compact />
      </div>
    </div>
  );
}
