/**
 * 模板编辑器（B2 #8）：输入框 + 变量芯片 + 实时预览。**受控组件**，不自己落库。
 *
 * 单独拆出来而不是写在弹窗里：默认模板弹窗用它，以后若类型定制也要预览，
 * 直接复用（规则 #11）。
 *
 * 🔴 红线：纯本地字符串替换，不调 AI、不联网。
 */
import { useMemo, useRef } from "react";
import { useAppStore, type HistoryItem } from "@/stores/appStore";
import { extractNoteDraft } from "@/lib/notes/extract";
import {
  EXAMPLE_TEMPLATE,
  TEMPLATE_VAR_NAMES,
  applyNoteTemplate,
  buildTemplateVars,
  pickTemplate,
} from "@/lib/notes/template";
import { getContentTypeMeta, isSecret } from "@/lib/contentTypes";
import { insertAtCursor } from "@/lib/insertAtCursor";
import styles from "./NoteTemplate.module.css";

/** 没任何可用卡片时的内置样本。时间写死一个字面值——它只是展示用的字符串 */
const FALLBACK_ITEM: HistoryItem = {
  id: "__sample__",
  text: "Rust 的 Pin 到底解决什么问题——自引用结构体移动后指针失效",
  time: "2026-09-01 14:32:07",
  type: "text",
  content: "",
  pinned: false,
  source: "Chrome",
  workspace: "default",
  content_type: "text",
  tags: [],
};

/** 扫多少条去找预览样本。历史可能有几千条，没必要全扫（规则 #8） */
const SAMPLE_SCAN_LIMIT = 30;

/**
 * 挑一条真实卡片当预览样本——比内置假数据有用得多，能直接看出模板对自己的内容合不合适。
 *
 * **跳过密钥类卡片**：预览会把全文摄到设置页上，而密钥卡片在卡片列表里本来是遮罩显示的，
 * 不能在这里绕过那个遮罩。走已有的 `isSecret`（规则 #11）。
 */
function pickSample(history: HistoryItem[]): { item: HistoryItem; real: boolean } {
  for (const it of history.slice(0, SAMPLE_SCAN_LIMIT)) {
    if (isSecret(it.content_type)) continue;
    if (extractNoteDraft(it)) return { item: it, real: true };
  }
  return { item: FALLBACK_ITEM, real: false };
}

interface Props {
  value: string;
  onChange: (next: string) => void;
  /** 传了就会提醒「这条样本的类型配了定制，实际不走默认模板」 */
  overrides?: Record<string, string>;
}

export function NoteTemplateEditor({ value, onChange, overrides }: Props) {
  const taRef = useRef<HTMLTextAreaElement>(null);

  // 订整个 history：弹窗开着时新卡片进来，预览也跟着变
  const history = useAppStore((s) => s.history);
  const sample = useMemo(() => pickSample(history), [history]);
  const draft = useMemo(
    () => extractNoteDraft(sample.item) ?? { title: "", content: sample.item.text },
    [sample],
  );

  const preview = useMemo(() => {
    const vars = buildTemplateVars(sample.item, draft);
    return value.trim() ? applyNoteTemplate(value, vars) : draft.content;
  }, [value, sample, draft]);

  // 这条样本的类型配了定制时，预览（走默认模板）就与实际转笔记结果不一样，得说清楚
  const shadowedBy =
    overrides && pickTemplate(value, overrides, sample.item.content_type) !== value
      ? getContentTypeMeta(sample.item.content_type || sample.item.type).label
      : null;

  return (
    <>
      <textarea
        ref={taRef}
        className={styles.ta}
        value={value}
        placeholder={"留空 = 保持现在的行为（直接用正文）\n点「填入示例」看看能写成什么样"}
        spellCheck={false}
        onChange={(e) => onChange(e.target.value)}
      />

      <div className={styles.row}>
        <button className="btn-secondary" onClick={() => onChange(EXAMPLE_TEMPLATE)}>
          填入示例
        </button>
        <button className="btn-secondary" disabled={!value} onClick={() => onChange("")}>
          清空
        </button>
      </div>

      <div className={styles.row}>
        <span className={styles.hint}>可用变量（点一下插到光标处）：</span>
        {TEMPLATE_VAR_NAMES.map((name) => {
          const snippet = `{{${name}}}`;
          return (
            <button
              key={name}
              className={styles.varBtn}
              onClick={() => onChange(insertAtCursor(taRef.current, value, snippet))}
            >
              {snippet}
            </button>
          );
        })}
      </div>
      <div className={styles.hint}>
        拼错的变量名（比如 <code>{"{{sorce}}"}</code>）<b>不报错、会原样出现在笔记里</b>——
        这比静默删掉一段文字好，而且下面预览里一眼就能看到。
      </div>

      <div className={styles.prevLabel}>
        预览（{sample.real ? "拿你最近一条卡片套" : "暂无可用卡片，用内置示例"}）
        {shadowedBy && `｜❗ 这条是「${shadowedBy}」，实际转笔记会走类型定制`}
      </div>
      <div className={`${styles.prev}${value.trim() ? "" : ` ${styles.prevEmpty}`}`}>
        {preview || "（空）"}
      </div>
    </>
  );
}
