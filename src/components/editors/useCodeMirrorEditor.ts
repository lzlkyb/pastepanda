/**
 * editors/useCodeMirrorEditor.ts — CodeMirror 6 宿主内核（规划 §8.1 1️⃣）。
 *
 * 从 `FullscreenEditor` 抽出的**与布局无关**那一层：CM6 装配 + 主题舱 +
 * 语言舱 + 全套编辑命令（即 [`ShellBridge`]）。两个宿主共用它：
 * - `FullscreenEditor`：独立窗口，带文件打开/保存、分栏拖拽、大纲、状态栏；
 * - （待做）笔记编辑弹窗：只要一个编辑框 + 格式栏，存数据库而不是文件。
 *
 * # 为何叫 useCodeMirrorEditor 而不是规划里写的 MarkdownEditorCore
 *
 * 这段装配是**类型无关**的——全屏外壳用同一套服务 9 种内容类型
 * （markdown / json / html / text / csv / code / log / diagram / diff），差异全由
 * `FullscreenTypeSpec` 驱动。叫它 Markdown* 而它同时在给 json/csv 编辑器供电，
 * 是误导性命名。笔记那边只是「拿 markdown 的 language 调它」。
 *
 * # 一条硬规矩：所有宿主回调必须走 ref
 *
 * 装配 effect 的依赖只有 `ready`，也就是整个扩展数组（含 keymap 与
 * updateListener）**只构建一次**。直接闭包捕获宿主传进来的函数，会把
 * **那一刻**的版本冻死。这不是理论风险：`9e401e6` 修的正是它——
 * Ctrl+S 保存的是文件**刚加载时**的内容，用户的编辑被静默丢弃；
 * 而工具栏按钮每次渲染都是新的，所以只有快捷键这条路中招，更难发现。
 *
 * 所以下面每个宿主回调（onSave / onSaveAs / onDocChange / insertPastedImages）
 * 都写进 `hostRef`，每次渲染刷新，扩展里只从 ref 现取。**不要改回直接闭包。**
 */
import { useRef, useCallback, useEffect, useMemo } from "react";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { EditorState, Compartment, type Extension } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import {
  defaultKeymap,
  history,
  historyKeymap,
  indentWithTab,
  toggleComment,
  indentMore,
  indentLess,
} from "@codemirror/commands";
import { syntaxHighlighting, defaultHighlightStyle, indentOnInput } from "@codemirror/language";
import { search, searchKeymap, highlightSelectionMatches } from "@codemirror/search";
import { planLinePrefix } from "@/lib/mdLinePrefix";
import type { ExtensionCtx, ShellBridge } from "./fullscreen/types";

/**
 * 亮色编辑器外观（CodeMirror chrome）。
 * 使用应用主题 CSS 变量，随 data-theme 自动取色；
 * 语法高亮由 defaultHighlightStyle（亮色）提供。
 */
const lightEditorChrome = EditorView.theme({
  "&": { backgroundColor: "var(--card-bg, #fff)", color: "var(--text-primary, #1a1a1a)" },
  ".cm-content": { caretColor: "var(--text-primary, #1a1a1a)" },
  ".cm-cursor, .cm-dropCursor": { borderLeftColor: "var(--text-primary, #1a1a1a)" },
  "&.cm-focused > .cm-scroller > .cm-selectionLayer .cm-selectionBackground, .cm-selectionBackground, .cm-content ::selection":
    { backgroundColor: "var(--accent-light, #E0F2FE)" },
  ".cm-gutters": { backgroundColor: "transparent", color: "var(--text-muted, #999)", border: "none" },
  ".cm-activeLine": { backgroundColor: "var(--hover, rgba(0,0,0,0.04))" },
  ".cm-activeLineGutter": { backgroundColor: "transparent" },
});

export interface CodeMirrorEditorOptions {
  /** 初始文档。**只在编辑器创建那一刻读**；改它不会重载（重载靠 `ready` 翻面）。 */
  initialText: string;
  /** 为 false 时不创建编辑器（宿主还在加载文件）。翻面会重建。 */
  ready: boolean;
  /** 暗色主题。变化时经主题舱重配置，**不**重建编辑器。 */
  isDark: boolean;
  /** 当前全文。宿主持有 text 状态，这里只用来组装 `bridge.text`。 */
  text: string;
  /** 类型专属语言模式工厂（来自 `FullscreenTypeSpec.language`）。 */
  language?: (ctx: ExtensionCtx) => Extension;
  /** 动态语言（code 类型）：为 true 时挂空舱，由 `reconfigureLanguage` 后补。 */
  dynamicLanguage?: boolean;
  /** 图片粘贴/拖入（markdown 专属，经 `language` 的 ctx 注入）。 */
  insertPastedImages?: (files: File[], view: EditorView) => void;
  /** 文档变化。宿主拿它更新 text 与脏标记。 */
  onDocChange?: (text: string) => void;
  /** Mod-s。不传也仍会屏蔽浏览器默认行为（避免触发 WebView 另存）。 */
  onSave?: () => void;
  /** Mod-Shift-s。 */
  onSaveAs?: () => void;
}

export function useCodeMirrorEditor(opts: CodeMirrorEditorOptions) {
  const {
    initialText, ready, isDark, text,
    language, dynamicLanguage, insertPastedImages,
    onDocChange, onSave, onSaveAs,
  } = opts;

  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // 编辑器主题舱：运行时在 oneDark（暗）与 lightEditorChrome（亮）间切换
  const themeCompartment = useRef(new Compartment());
  // 代码语言舱：code 类型按运行期语言名从 language-data 懒加载后重配置
  const languageCompartment = useRef(new Compartment());

  /**
   * 宿主回调的“现取”口。每次渲染重写——原因见文件头部那条硬规矩。
   * 注意 `initialText` 也在里面：它参与脏标记判定（由宿主算），不能冻。
   */
  const hostRef = useRef({ onDocChange, onSave, onSaveAs, insertPastedImages, insertFormat: (_b: string, _a?: string) => {} });
  hostRef.current.onDocChange = onDocChange;
  hostRef.current.onSave = onSave;
  hostRef.current.onSaveAs = onSaveAs;
  hostRef.current.insertPastedImages = insertPastedImages;

  // ─── 编辑命令（全部只依赖 viewRef，所以依赖数组恒空）───

  /**
   * 选区包裹格式（加粗/斜体/行内代码……），支持**切换**。
   *
   * 无选区时光标落在标记**中间**：旧实现插完 `****` 光标在四个星号之后，
   * 接着打字打在了格式外面。
   */
  const insertFormat = useCallback((before: string, after: string = "") => {
    const view = viewRef.current;
    if (!view) return;
    const { state } = view;
    const { from, to } = state.selection.main;
    const selected = state.sliceDoc(from, to);

    if (after) {
      // 切换 A：标记就在选区里
      if (
        selected.length >= before.length + after.length &&
        selected.startsWith(before) &&
        selected.endsWith(after)
      ) {
        const inner = selected.slice(before.length, selected.length - after.length);
        view.dispatch({
          changes: { from, to, insert: inner },
          selection: { anchor: from, head: from + inner.length },
        });
        view.focus();
        return;
      }
      // 切换 B：标记在选区两侧（双击选词时的典型情况）
      const outFrom = from - before.length;
      const outTo = to + after.length;
      if (
        outFrom >= 0 &&
        outTo <= state.doc.length &&
        state.sliceDoc(outFrom, from) === before &&
        state.sliceDoc(to, outTo) === after
      ) {
        view.dispatch({
          changes: { from: outFrom, to: outTo, insert: selected },
          selection: { anchor: outFrom, head: outFrom + selected.length },
        });
        view.focus();
        return;
      }
    }

    view.dispatch({
      changes: { from, to, insert: before + selected + after },
      // 有选区：保持选中内容，方便继续叠别的格式、或再点一下取消；
      // 无选区：光标落在标记**中间**，直接就能打字。
      selection: selected
        ? { anchor: from + before.length, head: from + before.length + selected.length }
        : { anchor: from + before.length },
    });
    view.focus();
  }, []);
  hostRef.current.insertFormat = insertFormat;

  /**
   * 行首块级前缀（标题/引用/列表/任务），支持**多行选区**与**切换**。
   *
   * ❌ 旧实现只拿 `selection.main.from` 那一行：选中五行点「无序列表」，
   * 只有第一行变成 `- `。而“选一段文字转列表”是 md 编辑器最高频的操作之一。
   * 同时旧实现无条件插入，重复点「引用」会叠成 `> > > `。
   * 具体语义与边界情况见 `planLinePrefix`（那里带单测）。
   */
  const insertLinePrefix = useCallback((prefix: string) => {
    const view = viewRef.current;
    if (!view) return;
    const { state } = view;
    const sel = state.selection.main;
    const firstNo = state.doc.lineAt(sel.from).number;
    const lastNo = state.doc.lineAt(sel.to).number;

    const lines = [];
    for (let n = firstNo; n <= lastNo; n++) lines.push(state.doc.line(n));
    const plan = planLinePrefix(
      lines.map((l) => l.text),
      prefix,
    );

    const changes = [];
    for (let i = 0; i < lines.length; i++) {
      const p = plan[i];
      if (!p) continue;
      changes.push({
        from: lines[i].from,
        to: lines[i].from + p.replaceLen,
        insert: p.insert,
      });
    }
    if (changes.length) view.dispatch({ changes });
    view.focus();
  }, []);

  /** 整体替换文档（JSON 格式化/压缩用），经 CodeMirror dispatch 自动触发脏标记 */
  const replaceDoc = useCallback((next: string) => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      changes: { from: 0, to: view.state.doc.length, insert: next },
    });
    view.focus();
  }, []);

  /**
   * 跳转到指定行。`where` 控制落点：
   * - `"center"`：JSON 错误徽章点击定位（`gotoLine`）
   * - `"start"`：大纲点击（`jumpToLine`），把该行顶到列表顶部
   *
   * 行号要钳进文档范围——大纲算的是 React state 里的 text，极端情况下可能
   * 比 CodeMirror 当前文档新一拍，doc.line() 拿到越界行号会直接抛。
   */
  const scrollToLine = useCallback((line: number, where: "center" | "start") => {
    const view = viewRef.current;
    if (!view) return;
    const doc = view.state.doc;
    const info = doc.line(Math.max(1, Math.min(line, doc.lines)));
    view.dispatch({
      selection: { anchor: info.from },
      effects: where === "center"
        ? EditorView.scrollIntoView(info.from, { y: "center" })
        : EditorView.scrollIntoView(info.from, { y: "start", yMargin: 24 }),
    });
    view.focus();
  }, []);

  const gotoLine = useCallback((line: number) => scrollToLine(line, "center"), [scrollToLine]);
  /** 大纲点击用：把目标行顶到顶部而不是居中 */
  const jumpToLine = useCallback((line: number) => scrollToLine(line, "start"), [scrollToLine]);

  // ─── 代码命令（注释/缩进，经 CodeMirror 命令实现，跟随语言语法）───
  const bridgeToggleComment = useCallback(() => {
    const view = viewRef.current;
    if (view) { toggleComment(view); view.focus(); }
  }, []);
  const bridgeIndentMore = useCallback(() => {
    const view = viewRef.current;
    if (view) { indentMore(view); view.focus(); }
  }, []);
  const bridgeIndentLess = useCallback(() => {
    const view = viewRef.current;
    if (view) { indentLess(view); view.focus(); }
  }, []);

  const bridge: ShellBridge = useMemo(
    () => ({
      text, replaceDoc, gotoLine, insertFormat, insertLinePrefix,
      toggleComment: bridgeToggleComment,
      indentMore: bridgeIndentMore,
      indentLess: bridgeIndentLess,
    }),
    [text, replaceDoc, gotoLine, insertFormat, insertLinePrefix, bridgeToggleComment, bridgeIndentMore, bridgeIndentLess]
  );

  // ─── CM6 装配（只跑一次，ready 翻面才重建）───
  useEffect(() => {
    if (!editorRef.current || !ready) return;

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        // 走 ref：直接用 onDocChange 会把初次渲染的那个闭包冻死
        hostRef.current.onDocChange?.(update.state.doc.toString());
      }
    });

    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLine(),
      indentOnInput(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      // 类型专属语言模式 + 扩展（markdown 额外带图片粘贴拦截）；
      // code 类型为动态语言：挂空舱，由宿主调 reconfigureLanguage 后补。
      // ctx.insertPastedImages 也走 ref：它依赖 docDir，而 docDir 在「从剪贴板内容
      // 模式打开一个文件」时会变——直接闭包会把旧的 docDir 冻在扩展里。
      dynamicLanguage || !language
        ? languageCompartment.current.of([])
        : language({
            insertPastedImages: (files, view) =>
              hostRef.current.insertPastedImages?.(files, view),
          }),
      themeCompartment.current.of(isDark ? oneDark : lightEditorChrome),
      search(),
      highlightSelectionMatches(),
      // ❌ history() 必须显式装：这里是手搭扩展数组、没用 basicSetup，
      // 而 CodeMirror 6 的撤销栈是独立扩展。漏了它（以及 historyKeymap）
      // 的后果是 **Ctrl+Z 完全不工作** —— 一个编辑器不能撤销，比缺任何功能都致命。
      history(),
      keymap.of([
        // ⬆ 自定义绑定排在最前：CodeMirror 的 keymap 按数组顺序定优先级，
        // 放后面会被 defaultKeymap 里的同名绑定（如 macOS 的 emacs 风 Ctrl-B）抢掉。
        //
        // ❌ 全部走 hostRef 而不直接闭包捕获：原因见文件头部那条硬规矩。
        { key: "Mod-s", run: () => { hostRef.current.onSave?.(); return true; } },
        { key: "Mod-Shift-s", run: () => { hostRef.current.onSaveAs?.(); return true; } },
        // 格式栏的 tooltip 一直写着「粗体 Ctrl+B」「斜体 Ctrl+I」，但从来没实现过。
        // 提示词说谎比没有提示词更坏：用户按了没反应，只会以为是自己记错了。
        { key: "Mod-b", run: () => { hostRef.current.insertFormat("**", "**"); return true; } },
        { key: "Mod-i", run: () => { hostRef.current.insertFormat("*", "*"); return true; } },
        ...historyKeymap,
        // search() 早就装了，但搜索面板的快捷键在 searchKeymap 里 ——
        // 没这一行的话 Ctrl+F 没有任何反应，整个搜索功能根本没入口。
        ...searchKeymap,
        ...defaultKeymap,
        indentWithTab,
      ]),
      updateListener,
      EditorView.lineWrapping,
    ];

    const view = new EditorView({
      state: EditorState.create({ doc: initialText, extensions }),
      parent: editorRef.current,
    });

    viewRef.current = view;
    view.focus();

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [ready]);

  // 主题明暗变化时重配置 CodeMirror 外观（编辑器已创建后才生效）
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: themeCompartment.current.reconfigure(isDark ? oneDark : lightEditorChrome),
    });
  }, [isDark]);

  /**
   * 重配置语言舱（code 类型用）。宿主负责按语言名懒加载模式，
   * 拿到 Extension 后交给这里换上去。null = 纯文本。
   */
  const reconfigureLanguage = useCallback((ext: Extension | null) => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: languageCompartment.current.reconfigure(ext ?? []),
    });
  }, []);

  // 只导出真有人用的：insertFormat / insertLinePrefix / replaceDoc / gotoLine 已在
  // `bridge` 里，再单独导一份只是无消费者的 API 面。
  // jumpToLine 单独导：它不在 ShellBridge 里（bridge.gotoLine 是居中定位，
  // jumpToLine 是顶到顶部，两个落点不同）。
  return { editorRef, viewRef, bridge, jumpToLine, reconfigureLanguage };
}
