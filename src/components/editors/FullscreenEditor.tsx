/**
 * FullscreenEditor — 全屏编辑器通用外壳（独立 OS 全屏窗口）。
 *
 * 架构（通用外壳 + 类型主体）：
 *   - 外壳 100% 复用：工具栏 / 保存分流 / 自动保存 / 主题跟随 / 关闭守卫 /
 *     状态栏 / 查找替换 / 分栏拖拽 / 图片粘贴（markdown）。
 *   - 内容类型（markdown/json/html/text/csv）经 init 数据的 contentType 字段
 *     在 fullscreen/registry 查表得到 FullscreenTypeSpec，仅以下差异：
 *     CodeMirror 语言模式 / 视图形态 / 格式栏 / 预览面板。
 *
 * 入口：
 *   - 卡片小弹窗点"全屏" → open_fullscreen_editor({sourceId, content, contentType})
 *   - 系统双击 .md 文件 → open_fullscreen_editor({filePath, contentType})
 *   - 窗口已存在时 Rust 经 md-editor-load 事件推送新数据（key 变更整体重载）。
 */
import { useRef, useState, useCallback, useEffect, useMemo, Suspense } from "react";
import { FolderOpen, Save, X, Maximize2, Minimize2 } from "lucide-react";
import { EditorView, keymap, lineNumbers, highlightActiveLine } from "@codemirror/view";
import { EditorState, Compartment, type Extension } from "@codemirror/state";
import { oneDark } from "@codemirror/theme-one-dark";
import { defaultKeymap, indentWithTab, toggleComment, indentMore, indentLess } from "@codemirror/commands";
import { syntaxHighlighting, defaultHighlightStyle, indentOnInput } from "@codemirror/language";
import { search, highlightSelectionMatches } from "@codemirror/search";
import { THEMES, DEFAULT_THEME, type ThemeKey } from "@/lib/theme";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { save, open } from "@tauri-apps/plugin-dialog";
import { writeFile, mkdir } from "@tauri-apps/plugin-fs";
import { appDataDir, join } from "@tauri-apps/api/path";
import { useToast } from "@/components/Toast";
import { resolveFullscreenType } from "./fullscreen/registry";
import { LanguagePicker } from "./fullscreen/LanguagePicker";
import { loadLanguageSupport, languageFileExtension } from "./fullscreen/languages";
import type { ViewMode, ShellBridge } from "./fullscreen/types";
import styles from "./FullscreenEditor.module.css";

/** Rust 传递的编辑器初始数据（take_editor_init 返回值 / md-editor-load 事件载荷） */
interface EditorInit {
  sourceId: string | null;
  content: string | null;
  filePath: string | null;
  contentType: string | null;
  /** 语言提示（如 "Rust"、"YAML"），code 类型据此加载 CodeMirror 语言模式 */
  language: string | null;
}

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

/** 粘贴/拖入图片的 MIME → 扩展名映射（未知类型兜底 png） */
const IMAGE_EXT: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/bmp": "bmp",
  "image/svg+xml": "svg",
};

// ─── Root Component (独立窗口入口) ───────────────────────

export function FullscreenEditor() {
  const [init, setInit] = useState<(EditorInit & { nonce: number }) | null>(null);
  // 退场动画状态：关闭时先播放 windowExit（约 190ms），再真正关窗
  const [closing, setClosing] = useState(false);
  const closingRef = useRef(false);

  useEffect(() => {
    let mounted = true;
    // 首次挂载：取走 Rust 在创建窗口前暂存的初始数据
    invoke<EditorInit | null>("take_editor_init")
      .then((data) => {
        if (!mounted) return;
        setInit({
          sourceId: data?.sourceId ?? null,
          content: data?.content ?? null,
          filePath: data?.filePath ?? null,
          contentType: data?.contentType ?? null,
          language: data?.language ?? null,
          nonce: Date.now(),
        });
      })
      .catch(() => {
        if (mounted) setInit({ sourceId: null, content: "", filePath: null, contentType: null, language: null, nonce: Date.now() });
      });
    // 后续打开：窗口已存在时 Rust emit md-editor-load 推送新数据，整体重载
    const unlisten = listen<EditorInit>("md-editor-load", (e) => {
      // 退场动画中被复用（极罕见竞态）：重置关闭状态，让新内容正常入场
      closingRef.current = false;
      setClosing(false);
      setInit({
        sourceId: e.payload.sourceId ?? null,
        content: e.payload.content ?? null,
        filePath: e.payload.filePath ?? null,
        contentType: e.payload.contentType ?? null,
        language: e.payload.language ?? null,
        nonce: Date.now(),
      });
    });
    return () => {
      mounted = false;
      unlisten.then((fn) => fn());
    };
  }, []);

  const handleClose = useCallback(() => {
    if (closingRef.current) return;
    const doClose = () => {
      invoke("close_editor_window").catch(() => getCurrentWindow().close());
    };
    // 「窗口动画」关闭（editor-main.tsx 挂 no-anim 类）：跳过快照直接关窗
    if (document.documentElement.classList.contains("no-anim")) {
      doClose();
      return;
    }
    closingRef.current = true;
    setClosing(true);
    window.setTimeout(doClose, 190);
  }, []);

  if (!init) {
    return (
      <div className={styles.overlay}>
        <div className={styles.loading}>加载中…</div>
      </div>
    );
  }

  return (
    <div className={`${styles.windowRoot}${closing ? ` ${styles.windowExit}` : ""}`}>
      <FullscreenInner
        key={init.nonce}
        sourceId={init.sourceId}
        initContent={init.content}
        initFilePath={init.filePath}
        contentType={init.contentType}
        initLanguage={init.language}
        onClose={handleClose}
      />
    </div>
  );
}

// ─── Inner Component (manages lifecycle) ─────────────────

interface FullscreenInnerProps {
  sourceId: string | null;
  initContent: string | null;
  initFilePath: string | null;
  contentType: string | null;
  /** 语言提示（自动标签派生），仅 code 类型消费 */
  initLanguage: string | null;
  onClose: () => void;
}

function FullscreenInner({ sourceId, initContent, initFilePath, contentType, initLanguage, onClose }: FullscreenInnerProps) {
  const { toast } = useToast();

  // 类型规格：按 contentType 查表（未知/缺省回退 markdown）。本实例生命周期内固定。
  const spec = useMemo(() => resolveFullscreenType(contentType), [contentType]);

  // 初始内容 / 文件路径（content 情况直接用 props 初始化 state，避免 effect 时序导致空文档）
  const [initialContent, setInitialContent] = useState(initFilePath ? "" : initContent || "");
  const [currentFilePath, setCurrentFilePath] = useState<string | null>(null);
  const [fileName, setFileName] = useState(() => {
    if (initFilePath) return initFilePath.split(/[\\/]/).pop() || spec.defaultFileName;
    return sourceId ? "剪贴板内容" : spec.defaultFileName;
  });
  const [loading, setLoading] = useState(!!initFilePath);

  // 有效来源 id：从卡片进入后若用户又打开了别的文件，则清空（此后保存按文件处理）
  const [effectiveSourceId, setEffectiveSourceId] = useState<string | null>(sourceId);

  // Editor state
  const [text, setText] = useState(initFilePath ? "" : initContent || "");
  const [viewMode, setViewMode] = useState<ViewMode>(spec.defaultMode);
  const [isDirty, setIsDirty] = useState(false);
  const [showConfirmClose, setShowConfirmClose] = useState(false);
  // 全屏状态：决定切换按钮显示「放大」还是「缩回」图标
  const [isFullscreen, setIsFullscreen] = useState(false);
  // 自动保存开关（设置 md_auto_save，独立窗口经 get_config 读取）
  const [autoSaveEnabled, setAutoSaveEnabled] = useState(true);
  // 编辑器明暗：默认暗（与 DEFAULT_THEME ocean-dark 一致），读到实际主题后再校正
  const [isDarkTheme, setIsDarkTheme] = useState(true);

  // Split pane
  const [splitRatio, setSplitRatio] = useState(50);
  const isDragging = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // CodeMirror
  const editorRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  // 编辑器主题舱：运行时在 oneDark（暗）与 lightEditorChrome（亮）间切换
  const editorThemeCompartment = useRef(new Compartment());
  // 代码语言舱：code 类型按 languageName 从 language-data 懒加载语言模式后重配置
  const languageCompartment = useRef(new Compartment());
  // 当前代码语言（null = 纯文本）：初始来自自动标签派生，工具栏选择器可手动更改
  const [languageName, setLanguageName] = useState<string | null>(
    spec.dynamicLanguage ? initLanguage : null
  );

  // Preview scroll sync
  const previewScrollRef = useRef<HTMLDivElement>(null);
  const scrollSyncSource = useRef<"editor" | "preview" | null>(null);

  // ─── Load initial file (仅文件入口) ──────────────────
  useEffect(() => {
    if (initFilePath) {
      loadFile(initFilePath);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const loadFile = async (path: string) => {
    setLoading(true);
    try {
      const result = await invoke<string>("read_text_file_full", { path });
      setInitialContent(result);
      setText(result);
      setCurrentFilePath(path);
      setFileName(path.split(/[\\/]/).pop() || spec.defaultFileName);
      // 打开文件后，文档身份变为文件（不再回写来源卡片）
      setEffectiveSourceId(null);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      toast(msg || "无法打开文件", "error");
      onClose();
    } finally {
      setLoading(false);
    }
  };

  // ─── CodeMirror Setup ───────────────────────────────
  useEffect(() => {
    if (!editorRef.current || loading) return;

    const updateListener = EditorView.updateListener.of((update) => {
      if (update.docChanged) {
        const newText = update.state.doc.toString();
        setText(newText);
        setIsDirty(newText !== initialContent);
      }
    });

    const extensions: Extension[] = [
      lineNumbers(),
      highlightActiveLine(),
      indentOnInput(),
      syntaxHighlighting(defaultHighlightStyle, { fallback: true }),
      // 类型专属语言模式 + 扩展（markdown 额外带图片粘贴拦截）；
      // code 类型为动态语言：挂空舱，由语言加载 effect 按 languageName 重配置
      spec.dynamicLanguage
        ? languageCompartment.current.of([])
        : spec.language({ insertPastedImages }),
      editorThemeCompartment.current.of(isDarkTheme ? oneDark : lightEditorChrome),
      search(),
      highlightSelectionMatches(),
      keymap.of([
        ...defaultKeymap,
        indentWithTab,
        { key: "Mod-s", run: () => { handleSave(); return true; } },
        { key: "Mod-Shift-s", run: () => { handleSaveAs(); return true; } },
      ]),
      updateListener,
      EditorView.lineWrapping,
    ];

    const state = EditorState.create({
      doc: initialContent,
      extensions,
    });

    const view = new EditorView({
      state,
      parent: editorRef.current,
    });

    viewRef.current = view;
    view.focus();

    return () => {
      view.destroy();
      viewRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loading]);

  // 主题明暗变化时重配置 CodeMirror 外观（编辑器已创建后才生效）
  useEffect(() => {
    const view = viewRef.current;
    if (!view) return;
    view.dispatch({
      effects: editorThemeCompartment.current.reconfigure(
        isDarkTheme ? oneDark : lightEditorChrome
      ),
    });
  }, [isDarkTheme]);

  // code 类型：按 languageName 从 language-data 懒加载语言模式（带缓存），
  // 加载完成后重配置 languageCompartment；null = 纯文本（空扩展）
  useEffect(() => {
    if (!spec.dynamicLanguage || loading) return;
    const view = viewRef.current;
    if (!view) return;
    if (!languageName) {
      view.dispatch({ effects: languageCompartment.current.reconfigure([]) });
      return;
    }
    let cancelled = false;
    loadLanguageSupport(languageName)
      .then((support) => {
        if (cancelled || !viewRef.current) return;
        viewRef.current.dispatch({
          effects: languageCompartment.current.reconfigure(support ?? []),
        });
      })
      .catch(() => { /* 加载失败保持纯文本模式 */ });
    return () => { cancelled = true; };
  }, [languageName, loading, spec.dynamicLanguage]);

  // 语言切换后联动默认文件名扩展名（如 剪贴板内容 → 剪贴板内容.rs）；
  // 已打开真实文件时不覆盖文件原名
  useEffect(() => {
    if (!spec.dynamicLanguage || currentFilePath) return;
    setFileName((prev) => {
      const ext = languageName ? languageFileExtension(languageName) : "txt";
      if (!ext) return prev;
      const base = prev.replace(/\.[^.]*$/, "");
      return `${base}.${ext}`;
    });
  }, [languageName, spec.dynamicLanguage, currentFilePath]);

  // 编辑区从隐藏（仅预览）恢复显示时，请求 CodeMirror 重新测量布局，
  // 避免 display:none 期间尺寸为 0 导致恢复后行高/槽宽渲染异常。
  useEffect(() => {
    if (viewMode !== "preview") {
      viewRef.current?.requestMeasure();
    }
  }, [viewMode]);

  // ─── File Operations ────────────────────────────────
  const handleSave = useCallback(async () => {
    // 1) 来自剪贴板卡片：回写数据库（主窗口经 history-item-updated 事件刷新）
    if (effectiveSourceId) {
      try {
        await invoke("update_history", { id: effectiveSourceId, text });
        setInitialContent(text);
        setIsDirty(false);
        toast("已保存", "success");
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        toast("保存失败: " + msg, "error");
      }
      return;
    }
    // 2) 无文件路径：另存为
    if (!currentFilePath) {
      return handleSaveAs();
    }
    // 3) 来自文件：写文件 + 按设置开关决定是否写入剪贴板历史
    try {
      const encoder = new TextEncoder();
      await writeFile(currentFilePath, encoder.encode(text));
      setInitialContent(text);
      setIsDirty(false);
      try {
        const cfg = await invoke<{ md_save_to_history?: boolean; current_workspace?: string }>("get_config");
        if (cfg.md_save_to_history) {
          await invoke("insert_markdown_history", {
            text,
            workspace: cfg.current_workspace || "默认",
          });
        }
      } catch {
        /* 入剪贴板库失败不影响文件保存成功 */
      }
      toast("已保存", "success");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      toast("保存失败: " + msg, "error");
    }
  }, [effectiveSourceId, currentFilePath, text, toast]);

  const handleSaveAs = useCallback(async () => {
    try {
      const selectedPath = await save({
        defaultPath: fileName,
        filters: [spec.fileFilter],
      });
      if (!selectedPath) return;
      const encoder = new TextEncoder();
      await writeFile(selectedPath, encoder.encode(text));
      setCurrentFilePath(selectedPath);
      setFileName(selectedPath.split(/[\\/]/).pop() || spec.defaultFileName);
      setInitialContent(text);
      setIsDirty(false);
      toast("已保存", "success");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      toast("保存失败: " + msg, "error");
    }
  }, [text, fileName, spec, toast]);

  const handleOpen = useCallback(async () => {
    try {
      const selected = await open({
        filters: [spec.fileFilter],
        multiple: false,
      });
      if (selected) {
        await loadFile(selected as string);
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      toast(msg || "打开失败", "error");
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [spec, toast]);

  // ─── 读取配置（自动保存开关 + 主题明暗）───
  // 独立窗口不与主窗口共享 store，设置经 get_config 读取
  useEffect(() => {
    invoke<{ md_auto_save?: boolean; theme?: string }>("get_config")
      .then((cfg) => {
        setAutoSaveEnabled(cfg.md_auto_save !== false);
        const themeKey = (cfg.theme || DEFAULT_THEME) as ThemeKey;
        const themeDef = THEMES.find((t) => t.key === themeKey);
        setIsDarkTheme(themeDef ? themeDef.dark : true);
      })
      .catch(() => { /* 读取失败时保持默认（自动保存开、暗色编辑器） */ });
  }, []);

  const autoSaveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    // 功能关闭 / 无保存目标（新建未命名文档）/ 无改动 → 不触发
    if (!autoSaveEnabled) return;
    if (!effectiveSourceId && !currentFilePath) return;
    if (text === initialContent) return;

    if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    autoSaveTimer.current = setTimeout(async () => {
      const snapshot = text;
      try {
        if (effectiveSourceId) {
          // 卡片 → 回写数据库（主窗口经 history-item-updated 事件刷新）
          await invoke("update_history", { id: effectiveSourceId, text: snapshot });
        } else if (currentFilePath) {
          // 文件 → 写回磁盘（自动保存不写剪贴板历史，避免重复入历史）
          const encoder = new TextEncoder();
          await writeFile(currentFilePath, encoder.encode(snapshot));
        }
        setInitialContent(snapshot);
        setIsDirty(false);
      } catch {
        /* 自动保存失败静默处理：保留脏状态，用户仍可 Ctrl+S 手动重试 */
      }
    }, 1000);

    return () => {
      if (autoSaveTimer.current) clearTimeout(autoSaveTimer.current);
    };
  }, [text, initialContent, effectiveSourceId, currentFilePath, autoSaveEnabled]);

  // ─── Close with dirty guard ─────────────────────────
  const handleClose = useCallback(() => {
    if (isDirty) {
      setShowConfirmClose(true);
    } else {
      onClose();
    }
  }, [isDirty, onClose]);

  const handleConfirmClose = useCallback(async () => {
    setShowConfirmClose(false);
    // 关闭前尝试保存
    if (effectiveSourceId) {
      try { await invoke("update_history", { id: effectiveSourceId, text }); } catch { /* ignore */ }
    } else if (currentFilePath) {
      try {
        const encoder = new TextEncoder();
        await writeFile(currentFilePath, encoder.encode(text));
      } catch { /* ignore */ }
    }
    onClose();
  }, [effectiveSourceId, currentFilePath, text, onClose]);

  // ─── Keyboard shortcuts ─────────────────────────────
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        handleClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [handleClose]);

  // ─── Fullscreen state sync ─────────────────────────
  useEffect(() => {
    const win = getCurrentWindow();
    let disposed = false;
    let unlistenResize: (() => void) | undefined;
    // 挂载时初始化按钮图标
    win.isFullscreen().then((fs) => { if (!disposed) setIsFullscreen(fs); }).catch(() => {});
    // 进出全屏会触发窗口 resized 事件，借此同步图标状态
    win.onResized(() => {
      win.isFullscreen().then((fs) => { if (!disposed) setIsFullscreen(fs); }).catch(() => {});
    }).then((fn) => { if (disposed) fn(); else unlistenResize = fn; });
    return () => {
      disposed = true;
      unlistenResize?.();
    };
  }, []);

  // 全屏切换：真全屏 ↔ 94%×90% 大窗（退出全屏时系统自动恢复原尺寸位置）
  const toggleFullscreen = useCallback(async () => {
    try {
      const win = getCurrentWindow();
      const next = !(await win.isFullscreen());
      await win.setFullscreen(next);
      setIsFullscreen(next);
    } catch (e) {
      console.error("[全屏切换] 失败:", e);
    }
  }, []);

  // ─── Format helpers（经 ShellBridge 提供给类型格式栏）───
  const insertFormat = useCallback((before: string, after: string = "") => {
    const view = viewRef.current;
    if (!view) return;
    const { from, to } = view.state.selection.main;
    const selected = view.state.sliceDoc(from, to);
    view.dispatch({
      changes: { from, to, insert: before + selected + after },
      selection: { anchor: from + before.length + selected.length + after.length },
    });
    view.focus();
  }, []);

  const insertLinePrefix = useCallback((prefix: string) => {
    const view = viewRef.current;
    if (!view) return;
    const { from } = view.state.selection.main;
    const line = view.state.doc.lineAt(from);
    view.dispatch({
      changes: { from: line.from, to: line.from, insert: prefix },
    });
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

  /** 跳转到指定行（1 起）并居中显示 — JSON 错误徽章点击定位用 */
  const gotoLine = useCallback((line: number) => {
    const view = viewRef.current;
    if (!view) return;
    const doc = view.state.doc;
    const ln = doc.line(Math.max(1, Math.min(line, doc.lines)));
    view.dispatch({
      selection: { anchor: ln.from },
      effects: EditorView.scrollIntoView(ln.from, { y: "center" }),
    });
    view.focus();
  }, []);

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

  // ─── 图片粘贴 / 拖入（markdown 专属，经 spec.language 的 ctx 注入）───
  // 保存到 $APPDATA/md-editor-images（asset 协议作用域内，预览可直接渲染），
  // 并在光标处插入 Markdown 引用（路径转正斜杠，避免反斜杠被当作转义）。
  const insertPastedImages = useCallback(async (files: File[], view: EditorView) => {
    try {
      const baseDir = await appDataDir();
      const imgDir = await join(baseDir, "md-editor-images");
      await mkdir(imgDir, { recursive: true });

      const refs: string[] = [];
      for (const file of files) {
        const ext = IMAGE_EXT[file.type] || "png";
        const name = `img-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
        const fullPath = await join(imgDir, name);
        const bytes = new Uint8Array(await file.arrayBuffer());
        await writeFile(fullPath, bytes);
        // 路径转正斜杠并用 < > 包裹（兼容含空格的路径）
        refs.push(`![image](<${fullPath.replace(/\\/g, "/")}>)`);
      }

      const insertText = refs.join("\n");
      const { from, to } = view.state.selection.main;
      view.dispatch({
        changes: { from, to, insert: insertText + "\n" },
        selection: { anchor: from + insertText.length + 1 },
      });
      view.focus();
    } catch (e) {
      console.error("[图片粘贴] 保存失败:", e);
      toast("图片保存失败", "error");
    }
  }, [toast]);

  // ─── Scroll sync（仅 markdown 启用）─────────────────
  const handleEditorScroll = useCallback(() => {
    if (scrollSyncSource.current === "preview") return;
    scrollSyncSource.current = "editor";
    const editorEl = editorRef.current?.querySelector(".cm-scroller");
    const previewEl = previewScrollRef.current;
    if (!editorEl || !previewEl) return;
    const ratio = editorEl.scrollTop / (editorEl.scrollHeight - editorEl.clientHeight || 1);
    previewEl.scrollTop = ratio * (previewEl.scrollHeight - previewEl.clientHeight);
    requestAnimationFrame(() => { scrollSyncSource.current = null; });
  }, []);

  const handlePreviewScroll = useCallback(() => {
    if (scrollSyncSource.current === "editor") return;
    scrollSyncSource.current = "preview";
    const editorEl = editorRef.current?.querySelector(".cm-scroller");
    const previewEl = previewScrollRef.current;
    if (!editorEl || !previewEl) return;
    const ratio = previewEl.scrollTop / (previewEl.scrollHeight - previewEl.clientHeight || 1);
    editorEl.scrollTop = ratio * (editorEl.scrollHeight - editorEl.clientHeight);
    requestAnimationFrame(() => { scrollSyncSource.current = null; });
  }, []);

  // Attach scroll listeners（spec.scrollSync 为 true 才挂载）
  useEffect(() => {
    if (!spec.scrollSync) return;
    const editorScroller = editorRef.current?.querySelector(".cm-scroller");
    const previewEl = previewScrollRef.current;
    if (editorScroller) editorScroller.addEventListener("scroll", handleEditorScroll);
    if (previewEl) previewEl.addEventListener("scroll", handlePreviewScroll);
    return () => {
      if (editorScroller) editorScroller.removeEventListener("scroll", handleEditorScroll);
      if (previewEl) previewEl.removeEventListener("scroll", handlePreviewScroll);
    };
  }, [handleEditorScroll, handlePreviewScroll, viewMode, spec.scrollSync]);

  // ─── Resize drag ────────────────────────────────────
  const handleResizeStart = useCallback((e: React.MouseEvent) => {
    e.preventDefault();
    isDragging.current = true;
    document.body.style.cursor = "col-resize";
    document.body.style.userSelect = "none";

    const onMove = (ev: MouseEvent) => {
      if (!isDragging.current || !containerRef.current) return;
      const rect = containerRef.current.getBoundingClientRect();
      const pct = ((ev.clientX - rect.left) / rect.width) * 100;
      setSplitRatio(Math.min(70, Math.max(30, pct)));
    };

    const onUp = () => {
      isDragging.current = false;
      document.body.style.cursor = "";
      document.body.style.userSelect = "";
      window.removeEventListener("mousemove", onMove);
      window.removeEventListener("mouseup", onUp);
    };

    window.addEventListener("mousemove", onMove);
    window.addEventListener("mouseup", onUp);
  }, []);

  // ─── Stats ──────────────────────────────────────────
  const stats = useMemo(() => {
    const lines = text.split("\n").length;
    const chars = text.length;
    return { lines, chars };
  }, [text]);

  // ─── Render ─────────────────────────────────────────
  if (loading) {
    return (
      <div className={styles.overlay}>
        <div className={styles.loading}>加载中…</div>
      </div>
    );
  }

  const hasPreview = !!spec.Preview;

  return (
    <div
      className={styles.overlay}
      data-theme-mode={isDarkTheme ? "dark" : "light"}
    >
      {/* Toolbar（deep 拖拽区：按住文件名/图标/空白处可移动窗口，按钮自动豁免） */}
      <div className={styles.toolbar} data-tauri-drag-region="deep">
        <div className={styles.toolbarLeft}>
          <div className={styles.fileIcon}>{spec.icon}</div>
          <span className={styles.fileName}>{fileName}</span>
          {currentFilePath && (
            <span className={styles.filePath}>— {currentFilePath.replace(/[\\/][^\\/]+$/, "")}</span>
          )}
          {isDirty && <div className={styles.unsavedDot} />}
          {spec.dynamicLanguage && (
            <LanguagePicker value={languageName} onChange={setLanguageName} />
          )}
        </div>
        <div className={styles.toolbarRight}>
          <button className={styles.tbBtn} onClick={handleOpen} title="打开文件">
            <FolderOpen size={14} />
          </button>
          <button className={`${styles.tbBtn} ${styles.tbBtnPrimary}`} onClick={handleSave} title="保存 Ctrl+S">
            <Save size={14} />
            <span>保存</span>
          </button>
          {spec.modes.length > 1 && (
            <>
              <div className={styles.tbSep} />
              {spec.modes.map(({ key, title, Icon }) => (
                <button
                  key={key}
                  className={`${styles.tbBtnIcon} ${viewMode === key ? styles.tbBtnActive : ""}`}
                  onClick={() => setViewMode(key)}
                  title={title}
                >
                  <Icon size={15} />
                </button>
              ))}
            </>
          )}
          <div className={styles.tbSep} />
          <button
            className={styles.tbBtnIcon}
            onClick={toggleFullscreen}
            title={isFullscreen ? "缩回窗口" : "放大到真全屏"}
          >
            {isFullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
          <button className={`${styles.tbBtnIcon} ${styles.tbBtnClose}`} onClick={handleClose} title="关闭 Esc">
            <X size={15} />
          </button>
        </div>
      </div>

      {/* Format Bar（类型专属，无则不渲染） */}
      {spec.FormatBar && (
        <div className={styles.formatBar}>
          <spec.FormatBar bridge={bridge} />
        </div>
      )}

      {/* Main Content */}
      <div className={styles.main} ref={containerRef}>
        {/* Editor Pane — 始终挂载，仅预览时用 display:none 隐藏而非卸载。
            若条件卸载，CodeMirror 视图会随 DOM 移除而脱离文档，切回分屏时
            新建的空 div 不会被重新填充（初始化 effect 仅依赖 loading），导致编辑区被清空。 */}
        <div
          className={styles.editorPane}
          style={{
            flex: viewMode === "split" ? `0 0 ${splitRatio}%` : "1",
            display: viewMode === "preview" ? "none" : undefined,
          }}
        >
          <div className={styles.paneHeader}>
            <span className={styles.paneLabel}>编辑</span>
          </div>
          <div className={styles.editorBody} ref={editorRef} />
        </div>

        {/* Resize Handle */}
        {viewMode === "split" && hasPreview && (
          <div className={styles.resizeHandle} onMouseDown={handleResizeStart} />
        )}

        {/* Preview Pane */}
        {viewMode !== "edit" && hasPreview && spec.Preview && (
          <div
            className={styles.previewPane}
            style={{ flex: viewMode === "split" ? `0 0 ${100 - splitRatio}%` : "1" }}
          >
            <div className={styles.paneHeader}>
              <span className={styles.paneLabel}>预览</span>
              <span className={styles.paneSubLabel}>{spec.previewSubLabel}</span>
            </div>
            <div
              className={`${styles.previewBody} ${spec.previewFill ? styles.previewBodyFill : ""}`}
              ref={previewScrollRef}
            >
              <Suspense fallback={<div className={styles.previewLoading}>预览加载中…</div>}>
                <spec.Preview text={text} bridge={bridge} />
              </Suspense>
            </div>
          </div>
        )}
      </div>

      {/* Status Bar */}
      <div className={styles.statusBar}>
        <div className={styles.statusLeft}>
          <span className={styles.statusItem}>{fileName}</span>
          <span className={styles.statusItem}>{stats.lines} 行</span>
          <span className={styles.statusItem}>{stats.chars} 字符</span>
          <span className={styles.statusItem}>UTF-8</span>
        </div>
        <div className={styles.statusRight}>
          <span className={`${styles.statusItem} ${!isDirty ? styles.statusSaved : ""}`}>
            {isDirty ? "● 未保存" : "✓ 已保存"}
          </span>
          <span className={styles.statusItem}>
            {spec.dynamicLanguage ? (languageName ?? "纯文本") : spec.label}
          </span>
        </div>
      </div>

      {/* Confirm Close Dialog */}
      {showConfirmClose && (
        <ConfirmDialog
          open={showConfirmClose}
          title="有未保存的修改"
          message="关闭前是否保存更改？"
          confirmText="保存并关闭"
          cancelText="不保存"
          onConfirm={handleConfirmClose}
          onCancel={() => { setShowConfirmClose(false); onClose(); }}
        />
      )}
    </div>
  );
}
