/**
 * 配置结构化编辑器（Tier2）：接管 content_type = config。
 * 此前 config 走 CodeEditor（仅高亮）。本编辑器在保留原文高亮能力的基础上，
 * 增加「表格」视图：把 .env / ini / 通用 key:value 解析为可编辑行，
 * 注释行与嵌套结构原样保留（不解析、不破坏），改动即时回写。
 *
 * 行模型：每行对应原文本一行（index 即行号），kv 行可编辑 key/value，
 * comment/blank/section/other 行原样展示不可编辑。
 */
import { useState, useMemo, useEffect } from "react";
import { useEditorCore } from "./useEditorCore";
import { CodeTextArea } from "./CodeTextArea";
import { TransformToolbar, OriginalDiff, FullscreenLaunchButton } from "./editorBits";
import type { EditorProps } from "@/lib/editorRegistry";
// 解析/回写/格式检测已抽到 lib（规则 #11，且抽出后才可测：见 __tests__/configParser.test.ts）
import { parseConfig, emitLine, detectFormat, KEY_PATTERN, type LineDesc } from "@/lib/configParser";

/**
 * 一行 kv 的行内编辑。
 *
 * 键名走本地草稿而不是直接回写：键名一旦被写成非法形状（打进一个空格、或被清空），
 * 这行在下一次 parseConfig 就落到 `other` 分支、渲染成不可编辑的纯文本 div ——
 * 输入框当场卸载、焦点丢失、后面的字根本打不进去。
 * 所以草稿合法才回写，非法时只标红并提示，失焦仍非法就还原成原键名。
 * 值不需要这层保护：`(.*?)` 什么都能匹配，写什么都还是 kv 行。
 */
function KvRow({ d, onCommitKey, onChangeValue, onDelete }: {
  d: Extract<LineDesc, { type: "kv" }>;
  onCommitKey: (key: string) => void;
  onChangeValue: (value: string) => void;
  onDelete: () => void;
}) {
  const [draft, setDraft] = useState(d.key);
  // 外部改动（撤销/重做/切换视图后重新解析）时跟随最新键名
  useEffect(() => { setDraft(d.key); }, [d.key]);
  const valid = KEY_PATTERN.test(draft);

  return (
    <div className="cfg-row">
      <div className="cfg-key">
        <input
          value={draft}
          spellCheck={false}
          className={valid ? undefined : "cfg-key-invalid"}
          title={valid ? undefined : "键名只能包含字母、数字、下划线和 . / -，未生效"}
          onChange={(e) => {
            const next = e.target.value;
            setDraft(next);
            if (KEY_PATTERN.test(next)) onCommitKey(next);
          }}
          onBlur={() => { if (!valid) setDraft(d.key); }}
        />
      </div>
      <div className="cfg-val">
        <input value={d.value} spellCheck={false} onChange={(e) => onChangeValue(e.target.value)} />
      </div>
      <button className="cfg-del" title="删除此行" onClick={onDelete}>🗑</button>
    </div>
  );
}

export function ConfigEditor({ item, registerActions }: EditorProps) {
  const { text, pushHistory, undo, redo, originalText, isModified } = useEditorCore(item, registerActions);
  const [mode, setMode] = useState<"table" | "source">("table");
  const [showOriginal, setShowOriginal] = useState(false);

  const lines = useMemo(() => parseConfig(text), [text]);
  const kvCount = lines.filter((l) => l.type === "kv").length;
  const format = detectFormat(text);

  /** 替换第 i 行内容并写回历史 */
  const rewriteLine = (i: number, newLine: string) => {
    const arr = text.split("\n");
    if (i < 0 || i >= arr.length) return;
    arr[i] = newLine;
    pushHistory(arr.join("\n"));
  };

  const editKv = (i: number, key: string, value: string, d: LineDesc) => {
    rewriteLine(i, emitLine(d, key, value));
  };

  const deleteRow = (i: number) => {
    const arr = text.split("\n");
    arr.splice(i, 1);
    pushHistory(arr.join("\n"));
  };

  const addRow = () => {
    const arr = text.split("\n");
    // 去掉末尾空行后追加，避免堆积空行
    while (arr.length && arr[arr.length - 1].trim() === "") arr.pop();
    arr.push("NEW_KEY=value");
    pushHistory(arr.join("\n"));
  };

  const transform = (fn: (s: string) => string) => pushHistory(fn(text));

  return (
    <>
      <div className="code-meta-bar">
        <span className="badge">⚙️ 配置</span>
        <span>格式：{format}</span>
        <span>{kvCount} 项</span>
        <span className="spacer" />
        <div className="md-mode-toggle">
          <button className={"md-mode-btn" + (mode === "table" ? " active" : "")} onClick={() => setMode("table")}>表格</button>
          <button className={"md-mode-btn" + (mode === "source" ? " active" : "")} onClick={() => setMode("source")}>原文</button>
        </div>
      </div>

      {mode === "table" ? (
        <div className="config-body">
          <div className="cfg-note">行内编辑键/值即时保存；注释行与嵌套结构原样保留。</div>
          {lines.map((d, i) => {
            if (d.type === "blank") return <div key={`b-${i}`} style={{ height: 6 }} />;
            if (d.type === "comment")
              return <div key={`c-${i}`} className="cfg-comment">{d.raw}</div>;
            if (d.type === "other")
              return <div key={`o-${i}`} className="cfg-comment">{d.raw}</div>;
            if (d.type === "section")
              return <div key={`s-${i}`} className="cfg-section">[ {d.name} ]</div>;
            // kv 行
            return (
              <KvRow
                key={`kv-${i}`}
                d={d}
                onCommitKey={(key) => editKv(i, key, d.value, d)}
                onChangeValue={(value) => editKv(i, d.key, value, d)}
                onDelete={() => deleteRow(i)}
              />
            );
          })}
          <button className="cfg-add" onClick={addRow}>＋ 新增配置项</button>
        </div>
      ) : (
        <>
          <CodeTextArea value={text} onChange={pushHistory} textareaId="edit-config-textarea" />
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
      )}

      {mode === "table" && (
        <div className="edit-toolbar">
          <button className="tool-btn" onClick={undo}>↶ 撤销</button>
          <button className="tool-btn" onClick={redo}>↷ 重做</button>
          <span className="spacer" />
          <FullscreenLaunchButton itemId={item.id} text={text} contentType="config" />
        </div>
      )}
    </>
  );
}
