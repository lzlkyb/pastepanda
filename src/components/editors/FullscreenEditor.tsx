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
import { useRef, useState, useCallback, useEffect, useMemo, Suspense, lazy } from "react";
import { FolderOpen, Save, X, Maximize2, Minimize2, RefreshCw, ListTree } from "lucide-react";
import type { EditorView } from "@codemirror/view";
import { THEMES, DEFAULT_THEME, type ThemeKey } from "@/lib/theme";
// CM6 装配与全套编辑命令已抽到 useCodeMirrorEditor（规划 §8.1 1️⃣），
// 笔记编辑器将复用同一个 hook。本文件只剩「窗口 + 文件 + 布局」。
import { useCodeMirrorEditor } from "./useCodeMirrorEditor";
import { insertPastedImages as savePastedImages } from "./mdImagePaste";
import { MarkdownOutline } from "./fullscreen/MarkdownOutline";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { SkinScene } from "@/components/SkinScene";
import { invoke } from "@tauri-apps/api/core";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { listen } from "@tauri-apps/api/event";
import { save, open, ask } from "@tauri-apps/plugin-dialog";
import { useFileWatch } from "./useFileWatch";
import { useToast } from "@/components/Toast";
import { resolveFullscreenType } from "./fullscreen/registry";
import { LanguagePicker } from "./fullscreen/LanguagePicker";
import { loadLanguageSupport, languageFileExtension } from "./fullscreen/languages";
import type { ViewMode } from "./fullscreen/types";
import styles from "./FullscreenEditor.module.css";

/** 图文混排全屏（Tiptap）——惰加载：其它类型全屏不应为此多拉一份富文本库 */
const LazyRichFullscreen = lazy(() =>
  import("./fullscreen/RichFullscreen").then((m) => ({ default: m.RichFullscreen }))
);
/** 流程图全屏（React Flow）——惰加载：独立 OS 窗口，绕开 CodeMirror 路径 */
const LazyDiagramFullscreen = lazy(() =>
  import("./DiagramFullscreen").then((m) => ({ default: m.DiagramFullscreen }))
);
/** 文本对比全屏（双栏 diff）——惰加载：独立 OS 窗口，绕开 CodeMirror 单栏路径 */
const LazyDiffFullscreen = lazy(() =>
  import("./DiffEditorFullscreen").then((m) => ({ default: m.DiffEditorFullscreen }))
);

/** Rust 传递的编辑器初始数据（take_editor_init 返回值 / md-editor-load 事件载荷） */
interface EditorInit {
  sourceId: string | null;
  content: string | null;
  filePath: string | null;
  contentType: string | null;
  /** 语言提示（如 "Rust"、"YAML"），code 类型据此加载 CodeMirror 语言模式 */
  language: string | null;
}

/** 滚动同步的回声抑制窗口（ms）。
 *  要大于一帧（回声 scroll 事件在下一帧才到），又要小到用户主动改滚另一侧时不卡手。 */
const SCROLL_SYNC_ECHO_MS = 120;

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
        // V6.19：注册编辑器目标文件（截图"插入到文档"用）
        void invoke("set_editor_target", { editor_path: data?.filePath ?? null });
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
      // V6.19：更新编辑器目标文件
      void invoke("set_editor_target", { editor_path: e.payload.filePath ?? null });
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
      // V6.19：编辑器关闭 → 清除目标（截图"插入到文档"入口隐藏）
      void invoke("set_editor_target", { editor_path: null });
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
      {/* 图文混排走独立的 Tiptap 全屏：它与下面 FullscreenInner 那套 CodeMirror
          机制（语言模式/分屏预览/格式栏桥）完全无关，在这里提前分支，
          避免把两种数据模型揉进一个组件 */}
      {init.contentType === "rich" ? (
        <Suspense fallback={<div className={styles.overlay}><div className={styles.loading}>加载中…</div></div>}>
          <LazyRichFullscreen
            key={init.nonce}
            sourceId={init.sourceId}
            initContent={init.content}
            onClose={handleClose}
          />
        </Suspense>
      ) : init.contentType === "diagram" ? (
        <Suspense fallback={<div className={styles.overlay}><div className={styles.loading}>加载中…</div></div>}>
          <LazyDiagramFullscreen
            key={init.nonce}
            sourceId={init.sourceId}
            initContent={init.content}
            onClose={handleClose}
          />
        </Suspense>
      ) : init.contentType === "diff" ? (
        <Suspense fallback={<div className={styles.overlay}><div className={styles.loading}>加载中…</div></div>}>
          <LazyDiffFullscreen
            key={init.nonce}
            sourceId={init.sourceId}
            initContent={init.content}
            onClose={handleClose}
          />
        </Suspense>
      ) : (
        <FullscreenInner
          key={init.nonce}
          sourceId={init.sourceId}
          initContent={init.content}
          initFilePath={init.filePath}
          contentType={init.contentType}
          initLanguage={init.language}
          onClose={handleClose}
        />
      )}
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
  /**
   * 当前文档所在目录（剪贴板内容模式为 null）。
   * 预览靠它解相对图片路径，粘贴图片靠它决定存哪里。
   *
   * ⚠️ 必须定在这里而不是渲染体里：insertPastedImages 要用它，而 loading 时
   * 渲染函数会提前 return（只出一个“加载中”），定晚了就可能拿到未初始化的绑定。
   */
  const docDir = currentFilePath ? currentFilePath.replace(/[\\/][^\\/]+$/, "") : null;
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
  // 预览行号开关（设置 markdown_preview_line_numbers，默认开启）
  const [previewLineNumbers, setPreviewLineNumbers] = useState(true);
  // 编辑器明暗：默认亮（与 DEFAULT_THEME ocean 一致），读到实际主题后再校正
  const [isDarkTheme, setIsDarkTheme] = useState(false);

  // Split pane
  const [splitRatio, setSplitRatio] = useState(50);
  // 大纲侧栏（仅 markdown）。默认收起：短文档开着只是白占地方。
  const [showOutline, setShowOutline] = useState(false);
  /**
   * 保存命令的「现取」口。handleSave / handleSaveAs 定义在下方（它们依赖
   * currentFilePath 等状态），而 hook 要在这里就拿到快捷键回调，故用 ref 中转。
   * 实现在下方每次渲染写回这个 ref——原因同 useCodeMirrorEditor 内部的 hostRef。
   */
  const saveCmdsRef = useRef({ save: () => {}, saveAs: () => {} });
  const isDragging = useRef(false);
  const containerRef = useRef<HTMLDivElement>(null);

  // 当前代码语言（null = 纯文本）：初始来自自动标签派生，工具栏选择器可手动更改
  const [languageName, setLanguageName] = useState<string | null>(
    spec.dynamicLanguage ? initLanguage : null
  );

  /** 文档变化：同步 text 与脏标记。脏标记的基准是 initialContent，留在宿主算。 */
  const handleDocChange = useCallback((next: string) => {
    setText(next);
    setIsDirty(next !== initialContent);
  }, [initialContent]);

  /** 图片粘贴：逻辑在 mdImagePaste，这里只注入宿主特有的 docDir 与提示通道。 */
  const handlePastedImages = useCallback((files: File[], view: EditorView) => {
    void savePastedImages(files, view, {
      docDir,
      onError: (msg) => toast(msg, "error"),
    });
  }, [docDir, toast]);

  // ─── CodeMirror 内核（装配 + 主题/语言舱 + 全套编辑命令）───
  const { editorRef, viewRef, bridge, jumpToLine, reconfigureLanguage } = useCodeMirrorEditor({
    initialText: initialContent,
    ready: !loading,
    isDark: isDarkTheme,
    text,
    language: spec.language,
    dynamicLanguage: spec.dynamicLanguage,
    insertPastedImages: handlePastedImages,
    onDocChange: handleDocChange,
    onSave: () => saveCmdsRef.current.save(),
    onSaveAs: () => saveCmdsRef.current.saveAs(),
  });

  // Preview scroll sync
  const previewScrollRef = useRef<HTMLDivElement>(null);
  /** 滚动同步的“谁在驱动”时间窗（防回声，详见 syncScroll） */
  const scrollSyncLock = useRef<{ side: "editor" | "preview"; until: number } | null>(null);

  // ─── Load initial file (仅文件入口) ──────────────────
  useEffect(() => {
    if (initFilePath) {
      loadFile(initFilePath);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  /**
   * 磁盘版本监听。只在文件模式有意义——剪贴板内容模式下 `currentFilePath`
   * 为 null，hook 内部自动空转，不会白轮询。
   */
  const fileWatch = useFileWatch(currentFilePath);

  /**
   * 外部改动的处理：**没有未保存修改时直接重载**，有则弹窗让用户选。
   *
   * 不脏时不问：用户没改东西，“要不要重载”这个问题没有两个答案，
   * 问了只是多一步。脏时必须问——重载会丢掉他正在写的东西。
   */
  useEffect(() => {
    if (!fileWatch.externalChanged || !currentFilePath) return;
    if (!isDirty) {
      void loadFile(currentFilePath).then(() => {
        toast("文件已在外部更新，已重新加载", "info");
      });
      return;
    }
    void (async () => {
      const reload = await ask(
        "这个文件已被外部程序修改。\n\n重新加载会丢掉你当前未保存的修改。",
        {
          title: "文件已在外部修改",
          kind: "warning",
          okLabel: "重新加载（丢弃我的修改）",
          cancelLabel: "保留我的修改",
        }
      );
      if (reload) await loadFile(currentFilePath);
      // 选了保留：也要把标记清掉，否则每 2 秒弹一次。
      // 代价是下次保存时靠冲突检测再拦一道——那才是真正会丢数据的时刻。
      else await fileWatch.markSynced(currentFilePath);
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fileWatch.externalChanged, currentFilePath, isDirty]);

  /**
   * 工具栏的「重载」：从磁盘拿最新内容。
   *
   * 脏时先确认——这是个破坏性操作（等于丢弃自己的修改），
   * 而工具栏按钮很容易误点。不脏就直接重载，没什么可问的。
   */
  const handleReloadFromDisk = async () => {
    if (!currentFilePath) return;
    if (isDirty) {
      const ok = await ask(
        "从磁盘重新加载会丢掉你当前未保存的修改。",
        { title: "重新加载", kind: "warning", okLabel: "重新加载", cancelLabel: "取消" }
      );
      if (!ok) return;
    }
    await loadFile(currentFilePath);
    toast("已从磁盘重新加载", "success");
  };

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
      // 记下刚读到的是磁盘哪一版，后续才能判“外部改过了”
      await fileWatch.markSynced(path);
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      toast(msg || "无法打开文件", "error");
      onClose();
    } finally {
      setLoading(false);
    }
  };

  // CM6 装配与主题重配置已进 useCodeMirrorEditor（本文件顶部那次调用）。

  // code 类型：按 languageName 从 language-data 懒加载语言模式（带缓存），
  // 拿到后交给 hook 的 reconfigureLanguage 换上语言舱；null = 纯文本。
  useEffect(() => {
    if (!spec.dynamicLanguage || loading) return;
    if (!languageName) {
      reconfigureLanguage(null);
      return;
    }
    let cancelled = false;
    loadLanguageSupport(languageName)
      .then((support) => {
        if (cancelled) return;
        reconfigureLanguage(support ?? null);
      })
      .catch(() => { /* 加载失败保持纯文本模式 */ });
    return () => { cancelled = true; };
  }, [languageName, loading, spec.dynamicLanguage, reconfigureLanguage]);

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
    // viewRef 来自 useCodeMirrorEditor，eslint 认不出它是稳定 ref，故显式列入（身份恒定，不会多跑）
  }, [viewMode, viewRef]);

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
      // 保存前的冲突检测。不查就是**静默覆盖外部的修改**——比丢自己的
      // 编辑更糟，因为丢的是别人（或另一个工具）的活，而且没任何提示。
      if (await fileWatch.checkNow()) {
        const overwrite = await ask(
          "这个文件在你编辑期间已被外部程序修改。\n\n继续保存会覆盖掉外部的改动。",
          {
            title: "文件已在外部修改",
            kind: "warning",
            okLabel: "仍然覆盖",
            cancelLabel: "取消",
          }
        );
        if (!overwrite) {
          toast("已取消保存——可点工具栏的「重载」拿到最新内容", "info");
          return;
        }
      }
      // 走后端命令而不是 fs 插件：外部打开的文件不在 fs scope 里，插件会直接拒
      // （forbidden path … allow-write-file）。读取本来就走 read_text_file_full，写跟上。
      await invoke("write_text_file_full", { path: currentFilePath, text });
      setInitialContent(text);
      setIsDirty(false);
      // 刚写的就是磁盘最新版，不更新的话下一轮轮询会把自己的保存认成外部改动
      await fileWatch.markSynced(currentFilePath);
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
    // 不能补 handleSaveAs：它就定义在下一行，写进依赖数组会 TDZ ReferenceError。
    // 也不能补 fileWatch：useFileWatch 没 useMemo 包返回值，每渲染都是新对象。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveSourceId, currentFilePath, text, toast]);

  const handleSaveAs = useCallback(async () => {
    try {
      const selectedPath = await save({
        defaultPath: fileName,
        filters: [spec.fileFilter],
      });
      if (!selectedPath) return;
      // 与手动保存走同一条路：这里虽然 dialog 插件已把选中路径加进了 scope（用 writeFile
      // 也能成），但两条写入路径共存只会让「为什么这个能存那个不能」更难查。
      await invoke("write_text_file_full", { path: selectedPath, text });
      // 另存为换了路径，重建 mtime 基准（hook 里路径变会先把基准置 0）
      await fileWatch.markSynced(selectedPath);
      setCurrentFilePath(selectedPath);
      setFileName(selectedPath.split(/[\\/]/).pop() || spec.defaultFileName);
      setInitialContent(text);
      setIsDirty(false);
      toast("已保存", "success");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      toast("保存失败: " + msg, "error");
    }
    // fileWatch 每渲染都是新对象（useFileWatch 未 useMemo），补上会让本回调每渲染重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // ─── 读取配置（自动保存开关 + 主题明暗 + 预览行号）───
  // 独立窗口不与主窗口共享 store，设置经 get_config 读取
  useEffect(() => {
    invoke<{ md_auto_save?: boolean; theme?: string; markdown_preview_line_numbers?: boolean }>("get_config")
      .then((cfg) => {
        setAutoSaveEnabled(cfg.md_auto_save !== false);
        setPreviewLineNumbers(cfg.markdown_preview_line_numbers !== false);
        const themeKey = (cfg.theme || DEFAULT_THEME) as ThemeKey;
        const themeDef = THEMES.find((t) => t.key === themeKey);
        setIsDarkTheme(themeDef ? themeDef.dark : false);
      })
      .catch(() => { /* 读取失败时保持默认（自动保存开、行号开、亮色编辑器） */ });
  }, []);

  // 预览行号开关：翻转即时生效，并写回配置持久化（读全量 → 覆盖单键 → 写回）
  const togglePreviewLineNumbers = useCallback(() => {
    const next = !previewLineNumbers;
    setPreviewLineNumbers(next);
    invoke<Record<string, unknown>>("get_config")
      .then((cfg) => invoke("save_config", { config: { ...cfg, markdown_preview_line_numbers: next } }))
      .catch(() => { /* 持久化失败不影响开关即时生效 */ });
  }, [previewLineNumbers]);

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
          // 自动保存是**无人值守**的，所以碰到外部改动时绝不能弹窗（用户可能
          // 不在电脑前），也绝不能直接覆盖——那就是背景里静默干掉别人的修改。
          //
          // 正确做法：跳过本次、保留脏状态，交给轮询那条路（externalChanged
          // → 弹二选一）去处理。跟下面“自动保存失败静默处理，保留脏状态”同一个思路。
          if (await fileWatch.checkNow()) return;
          // 文件 → 写回磁盘（自动保存不写剪贴板历史，避免重复入历史）
          await invoke("write_text_file_full", { path: currentFilePath, text: snapshot });
          // 必须更新：不更新的话下一轮轮询会把**自己刚写的**认成外部改动，
          // 2 秒后弹一句“文件已在外部更新”并重载。
          await fileWatch.markSynced(currentFilePath);
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
    // 千万不能补 fileWatch：它每渲染换引用，而这是个 1s 防抖的自动保存。
    // 补上之后定时器会被反复重排，自动保存就永远触发不了。
    // eslint-disable-next-line react-hooks/exhaustive-deps
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
      // 关闭前保存同样要查冲突，而且这里是最后一道——窗口关掉后
      // 用户就再没机会挑回来了。所以不确认就不关。
      if (await fileWatch.checkNow()) {
        const overwrite = await ask(
          "这个文件已被外部程序修改。\n\n保存并关闭会覆盖掉外部的改动。",
          {
            title: "文件已在外部修改",
            kind: "warning",
            okLabel: "仍然覆盖并关闭",
            cancelLabel: "不关闭，我自己处理",
          }
        );
        if (!overwrite) return; // 注意：不调 onClose，窗口留着
      }
      try {
        await invoke("write_text_file_full", { path: currentFilePath, text });
        await fileWatch.markSynced(currentFilePath);
      } catch { /* ignore */ }
    }
    onClose();
    // fileWatch 同上（每渲染新对象）
    // eslint-disable-next-line react-hooks/exhaustive-deps
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

  // 每次渲染把最新实现写进 ref，供 CodeMirror 快捷键现取（原因见 saveCmdsRef 声明处）。
  // 粗体/斜体已在 hook 内部直接接 insertFormat，不必再经这里转一手。
  saveCmdsRef.current = {
    save: () => void handleSave(),
    saveAs: () => void handleSaveAs(),
  };

  // ─── Scroll sync（仅 markdown 启用）─────────────────
  /**
   * 双向滚动同步。两个旧 bug：
   *
   * ❌ 用 requestAnimationFrame 清除“正在同步”标记——拦不住回声。
   * 浏览器的 scroll 事件在**下一帧开始**才派发，而 rAF 回调在**本帧结束前**就跑了；
   * 标记先被清掉，程序化 scrollTop 触发的回声事件会被当成用户滚动反向同步回去。
   * 两次比例换算各取整一点，来回几次就累积漂移——“越滚越对不上”。
   * 改成时间窗：谁先滚谁在窗口内说话，另一侧的回声一律忽略。
   *
   * ❌ 旧实现还在 null 检查**之前**就置了标记：两个 ref 有一个为 null 时直接 return，
   * 标记永远留着，此后所有滚动同步全部失效。现在先拿到元素、再上锁。
   */
  const syncScroll = useCallback((side: "editor" | "preview") => {
    const editorEl = editorRef.current?.querySelector(".cm-scroller");
    const previewEl = previewScrollRef.current;
    if (!editorEl || !previewEl) return;
    const now = Date.now();
    const lock = scrollSyncLock.current;
    // 另一侧正在驱动同步 → 本次是它的回声，丢掉
    if (lock && lock.side !== side && now < lock.until) return;
    scrollSyncLock.current = { side, until: now + SCROLL_SYNC_ECHO_MS };
    const [src, dst] = side === "editor" ? [editorEl, previewEl] : [previewEl, editorEl];
    const ratio = src.scrollTop / (src.scrollHeight - src.clientHeight || 1);
    dst.scrollTop = ratio * (dst.scrollHeight - dst.clientHeight);
    // editorRef 来自 useCodeMirrorEditor，eslint 认不出它是稳定 ref，故显式列入
  }, [editorRef]);

  const handleEditorScroll = useCallback(() => syncScroll("editor"), [syncScroll]);
  const handlePreviewScroll = useCallback(() => syncScroll("preview"), [syncScroll]);

  // Attach scroll listeners（spec.scrollSync 为 true 才挂载）。
  // 依赖数组必须带 loading：从外部文件打开时 loading 初始为 true，渲染函数会提前 return 只出
  // 一个“加载中”占位（editorPane/previewPane 都不渲染），此时两个 ref 都是 null，这里
  // 挂不上任何监听器；loadFile 完成后 loading 才变 false、真正的编辑区/预览区才挂载。
  // 不把 loading 放进依赖数组，这个 effect 就只在第一次（ref 全是 null）跑一次，
  // 之后再也不会重跑，滚动同步从此失效——正是“从外部 md 文件打开”才复现、
  // 从卡片内容打开不复现的原因（后者 initFilePath 为空，loading 从一开始就是 false，
  // 首次渲染就直接是完整 UI，没有这个提前 return 的中间态）。
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
    // editorRef 同上：来自 hook，eslint 要求列入（稳定 ref，不影响重跑时机）
  }, [handleEditorScroll, handlePreviewScroll, viewMode, spec.scrollSync, loading, editorRef]);

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
    // 字数：中日韩按**字**计，拉丁文按**词**计。
    // ❌ 不能只用 \b\w+\b：中文没有词边界，一整段中文会被数成 1 词；
    // 也不能只看字符数：它把标点、空格、Markdown 标记全算进去了。
    const cjk = (text.match(/[一-鿿぀-ヿ가-힯]/g) || []).length;
    const latin = (text.match(/[A-Za-z0-9]+(?:['’-][A-Za-z0-9]+)*/g) || []).length;
    const words = cjk + latin;
    // 阅读时长按 300 字/分（中文常用口径）；不足 1 分钟也显示 1，
    // 显示「0 分钟」比不显示更无用。
    const readMin = words === 0 ? 0 : Math.max(1, Math.round(words / 300));
    return { lines, chars, words, readMin };
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
      {/* 皮肤场景层：fixed z-0，衬于工具栏/编辑区（z-1）之后，
          主题场景从透明 header（--header-bg-start: transparent）透出 */}
      <SkinScene />
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
          {/* 仅文件模式显示：剪贴板内容模式没有磁盘文件可重载，
              摆一个点了没反应的按钮比不摆更坏（所以不是禁用，是不出现）。 */}
          {currentFilePath && (
            <button
              className={styles.tbBtn}
              onClick={() => void handleReloadFromDisk()}
              title="从磁盘重新加载（文件在外部被修改过时用）"
            >
              <RefreshCw size={14} />
            </button>
          )}
          {/* 大纲：只对 markdown 有意义（其它类型没有 # 标题结构）。
              跟上面那个「重载」同一个思路：不适用就不出现，而不是摆个点了没反应的按钮。 */}
          {spec.key === "markdown" && (
            <button
              className={`${styles.tbBtn} ${showOutline ? styles.tbBtnActive : ""}`}
              onClick={() => setShowOutline((v) => !v)}
              title="大纲（按标题跳转）"
            >
              <ListTree size={14} />
            </button>
          )}
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
        {spec.key === "markdown" && showOutline && (
          <MarkdownOutline text={text} onJump={jumpToLine} />
        )}
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
            /* split 模式弹性填充剩余空间（100% − 编辑宽 − 6px 把手）：
               若与编辑面板同为 0 0 X%，三者总宽超出 .main 被 overflow:hidden 裁剪，
               贴右边缘的预览滚动条会被裁掉大半 */
            style={{ flex: viewMode === "split" ? "1 1 0" : "1" }}
          >
            <div className={styles.paneHeader}>
              <span className={styles.paneLabel}>预览</span>
              <span className={styles.paneSubLabel}>{spec.previewSubLabel}</span>
              {spec.key === "markdown" && (
                <button
                  type="button"
                  className={`${styles.lnToggle} ${previewLineNumbers ? styles.lnToggleActive : ""}`}
                  onClick={togglePreviewLineNumbers}
                  title="预览区行号（块级编号 + 代码行号）"
                >
                  <span className={styles.lnToggleDot} />
                  行号
                </button>
              )}
            </div>
            <div
              className={`${styles.previewBody} ${spec.previewFill ? styles.previewBodyFill : ""}`}
              ref={previewScrollRef}
            >
              <Suspense fallback={<div className={styles.previewLoading}>预览加载中…</div>}>
                <spec.Preview
                  text={text}
                  bridge={bridge}
                  lineNumbers={previewLineNumbers}
                  baseDir={docDir}
                />
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
          <span className={styles.statusItem}>{stats.words} 字</span>
          {stats.readMin > 0 && (
            <span className={styles.statusItem} title="按 300 字/分钟估算">
              约 {stats.readMin} 分钟读完
            </span>
          )}
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
