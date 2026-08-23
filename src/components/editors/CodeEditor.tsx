/**
 * 通用代码编辑器（方案 A · Tier0）：接管 content_type = code / shell。
 * （config 已由 ConfigEditor 的表格视图接管，见 editorRegistry；TYPE_BADGE 保留
 *   config 一项是为了外部直接复用本组件时不掉徽章。）
 * 与 TextEditor 的区别：
 *  - 类型徽章明确（💻代码 / ⚙️配置 / ⌨️命令）；
 *  - 提供「语言锁定」下拉，手动指定高亮语言（短片段自动检测不可靠时尤其有用）；
 *  - 其余复用 useEditorCore + CodeTextArea + TransformToolbar + OriginalDiff 全套。
 * 默认语言优先取自动标签（findLanguageTag），否则跟随自动检测结果。
 */
import { useState, useEffect, useMemo } from "react";
import { useEditorCore } from "./useEditorCore";
import { CodeTextArea } from "./CodeTextArea";
import { MetaBar, TransformToolbar, OriginalDiff, FullscreenLaunchButton } from "./editorBits";
import { findLanguageTag, COMMON_CODE_LANGS, COMMON_CONFIG_FMTS } from "./fullscreen/languages";
import { highlightCode, getLangLabel } from "@/lib/utils";
import type { EditorProps } from "@/lib/editorRegistry";

/** 显示名 → utils 高亮语言 key（小写）；TOML/INI/ENV 无 Shiki 模式，留空走纯文本 */
const DISPLAY_TO_LANGKEY: Record<string, string> = {
  Python: "python", JavaScript: "javascript", TypeScript: "typescript", Rust: "rust",
  Go: "go", Java: "java", SQL: "sql", HTML: "html", CSS: "css", Shell: "bash",
  YAML: "yaml", TOML: "", INI: "", ENV: "",
};

const TYPE_BADGE: Record<string, string> = {
  code: "💻 代码", config: "⚙️ 配置", shell: "⌨️ 命令",
};

export function CodeEditor({ item, registerActions }: EditorProps) {
  const { text, pushHistory, undo, redo, originalText, isModified } = useEditorCore(item, registerActions);
  const [showOriginal, setShowOriginal] = useState(false);
  const ct = item.content_type || "code";

  // 自动检测语言（带取消守卫，避免慢请求覆盖新内容）。
  // 防抖 300ms：这个检测只用来填徽章文字，逐键跑一遍 shiki 纯属浪费——
  // CodeTextArea 内部还会为了高亮再跑一次，同一份文本连按键都要高亮两遍。
  const [detected, setDetected] = useState("检测中…");
  useEffect(() => {
    if (text.length > 5000) { setDetected("文本"); return; }
    let cancelled = false;
    const timer = window.setTimeout(() => {
      highlightCode(text).then((r) => { if (!cancelled) setDetected(getLangLabel(r.language)); });
    }, 300);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [text]);

  // 语言锁定：初始用自动标签（若有），否则跟随自动检测
  const [forceDisplay, setForceDisplay] = useState<string | null>(() => findLanguageTag(item.tags) ?? null);
  const forceLangKey = forceDisplay ? (DISPLAY_TO_LANGKEY[forceDisplay] || "") : undefined;
  const displayLang = forceDisplay ?? detected;

  // 下拉可选项：常用代码语言 + 配置格式 + 当前锁定项
  const options = useMemo(() => {
    const set = new Set<string>([...COMMON_CODE_LANGS, ...COMMON_CONFIG_FMTS]);
    if (forceDisplay) set.add(forceDisplay);
    return Array.from(set);
  }, [forceDisplay]);

  const charCount = text.length;
  const lineCount = text.split("\n").length;
  const transform = (fn: (s: string) => string) => pushHistory(fn(text));

  return (
    <>
      <MetaBar
        lineCount={lineCount}
        charCount={charCount}
        isModified={isModified}
        badge={TYPE_BADGE[ct] || "💻 代码"}
        extra={
          <div style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
            <select
              className="md-mode-btn"
              style={{ padding: "2px 6px", fontSize: 11 }}
              value={displayLang}
              onChange={(e) => setForceDisplay(e.target.value === detected ? null : e.target.value)}
              title="锁定语法高亮语言"
            >
              <option value={detected}>{detected}</option>
              {options.filter((o) => o !== detected).map((o) => (
                <option key={o} value={o}>{o}</option>
              ))}
            </select>
            <FullscreenLaunchButton itemId={item.id} text={text} contentType={ct} language={findLanguageTag(item.tags)} />
          </div>
        }
      />

      <CodeTextArea value={text} onChange={pushHistory} textareaId="edit-code-textarea" forceLang={forceLangKey || undefined} />

      <TransformToolbar
        text={text}
        transform={transform}
        undo={undo}
        redo={redo}
        isModified={isModified}
        showOriginal={showOriginal}
        onToggleOriginal={() => setShowOriginal(!showOriginal)}
        isHtmlContent={false}
      />

      {showOriginal && isModified && <OriginalDiff originalText={originalText} />}
    </>
  );
}
