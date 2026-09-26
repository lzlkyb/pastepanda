/**
 * 单份文档的**文件态**：加载 / 保存 / 另存为 / 打开 / 磁盘冲突检测。
 *
 * 从 `FullscreenEditor.tsx`（原 1061 行）抽出的最大一块，拆的理由是规则 7 的
 * 体量红线。**逻辑与注释都是原样搬移**，只做了三处必要调整：
 *   ① `handleSaveAs` 挪到 `handleSave` 之前 —— 原实现里前者定义在后、靠
 *      `eslint-disable` 绕过 TDZ 引用，现在顺序理顺，依赖数组可以正常写全；
 *   ② 关闭前保存从「弹自己的确认框」改为 `saveForClose()` 返回布尔 ——
 *      多标签下守卫必须由宿主统一裁决（一次列清所有脏标签），不能每个标签各弹一个。
 *      该逻辑现已独立为 `useCloseSave`（本文件到 `.ts ≤ 400` 又贴线，见 ③）。
 *   ③ 自动保存独立为 `useAutoSaveFile` —— 本文件一度 456 行，越过
 *      `docs/结构设计规范.md` §3.1 的 `.ts ≤ 400`。拆的两块（自动保存、关闭前保存）
 *      本就边界清楚：前者只需「文本 + 基线 + 三个 setter」，后者只需四个值。
 *      顺带把两处 `eslint-disable react-hooks/exhaustive-deps` 换成了正确写法
 *      （依赖放 `checkNow`/`markSynced` 而非每渲染换引用的 `fileWatch` 对象）。
 *
 * ❗ 自动保存**不因标签切走而暂停**：用户开自动保存就是为了不管它，
 * 切走 = 不再保存是把「保活」变成「保丢」。
 */
import { useCallback, useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { EditorView } from "@codemirror/view";
import { ask, open, save } from "@tauri-apps/plugin-dialog";
import { useToast } from "@/components/Toast";
import { useLatest } from "@/hooks/useLatest";
import { languageFileExtension } from "./languages";
import { insertPastedImages as savePastedImages } from "../mdImagePaste";
import { useFileWatch } from "../useFileWatch";
import { useAutoSaveFile } from "./useAutoSaveFile";
import { useCloseSave } from "./useCloseSave";
import type { FullscreenTypeSpec } from "./types";

interface Opts {
  sourceId: string | null;
  initContent: string | null;
  initFilePath: string | null;
  /** 语言提示（自动标签派生），仅 code 类型消费 */
  initLanguage: string | null;
  spec: FullscreenTypeSpec;
  /** 本标签是否为当前活动标签（非活动时暂停 2s 磁盘轮询） */
  active: boolean;
  /** 设置里的自动保存开关 */
  autoSaveEnabled: boolean;
  /** 致命路径（打开文件失败等）：请求宿主关掉本标签 */
  onFatal: () => void;
}

export interface DocumentFileApi {
  text: string;
  /** 当前「已保存基线」。CodeMirror 的初始文本与脏标记基准都用它 */
  initialContent: string;
  currentFilePath: string | null;
  /** 当前文档所在目录（剪贴板内容模式为 null），预览解相对图片路径与粘贴图片落盘用 */
  docDir: string | null;
  fileName: string;
  effectiveSourceId: string | null;
  loading: boolean;
  isDirty: boolean;
  isSaving: boolean;
  autoSaveError: boolean;
  languageName: string | null;
  setLanguageName: (name: string | null) => void;
  handleDocChange: (next: string) => void;
  handlePastedImages: (files: File[], view: EditorView) => void;
  handleSave: () => Promise<void>;
  handleSaveAs: () => Promise<void>;
  handleOpen: () => Promise<void>;
  handleReloadFromDisk: () => Promise<void>;
  /** 关闭前保存。true = 已处置完毕（可关闭）；false = 取消或写盘失败（不要关） */
  saveForClose: () => Promise<boolean>;
}

export function useDocumentFile({
  sourceId,
  initContent,
  initFilePath,
  initLanguage,
  spec,
  active,
  autoSaveEnabled,
  onFatal,
}: Opts): DocumentFileApi {
  const { toast } = useToast();

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

  const [text, setText] = useState(initFilePath ? "" : initContent || "");
  const [isDirty, setIsDirty] = useState(false);
  /**
   * 「此刻的文本」。所有 `await` 之后要判断脏标记的地方都必须用它 —— 写盘、
   * 另存为对话框都可能停一会儿，期间用户完全可能继续打字（实测场景见
   * `useAutoSaveFile` 的说明）。用闭包里的 `text` 会把新增的那笔标成已保存，
   * 而关闭守卫正是按 `isDirty` 决定要不要拦 ⇒ 静默丢稿。
   */
  const latestTextRef = useLatest(text);
  // 写盘进行中（手动 Ctrl+S / 自动保存防抖到期后的实际写盘段）。
  // 防抖等待期不算：那还是「未保存」，写盘只有几十毫秒，转瞬即过是正确的反馈节奏。
  const [isSaving, setIsSaving] = useState(false);
  // 自动保存写盘失败（只读文件/盘满/路径被占）。必须单独记：状态栏只有两态时，
  // "防抖期间还没存"与"根本存不进去"长得一模一样；用户开着自动保存就是为了不管保存，
  // 连续失败十分钟后关窗、守卫弹二选一，他会因为"相信自动保存一直在跑"而选不保存 —— 终点是丢稿。
  const [autoSaveError, setAutoSaveError] = useState(false);

  // 当前代码语言（null = 纯文本）：初始来自自动标签派生，工具栏选择器可手动更改
  const [languageName, setLanguageName] = useState<string | null>(
    spec.dynamicLanguage ? initLanguage : null
  );

  /**
   * 磁盘版本监听。只在文件模式有意义——剪贴板内容模式下 `currentFilePath`
   * 为 null，hook 内部自动空转，不会白轮询。
   * active 门控：切走的标签停掉 2s 轮询（规则 8.2），切回来时 effect 重挂自动恢复。
   */
  const fileWatch = useFileWatch(currentFilePath, active);

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
      onFatal();
    } finally {
      setLoading(false);
    }
  };

  // ─── Load initial file (仅文件入口) ──────────────────
  useEffect(() => {
    if (initFilePath) {
      loadFile(initFilePath);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // ─── File Operations ────────────────────────────────
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
      // 另存为的暴露面最大：`save()` 是系统对话框，可能停很久，用户很容易
      // 在这期间继续打字。基线仍用写下去的 text，脏否要看「此刻的文本」。
      setIsDirty(latestTextRef.current !== text);
      setAutoSaveError(false); // 另存为换了可写的新路径，旧路径的失败标记已无意义
      toast("已保存", "success");
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      toast("保存失败: " + msg, "error");
    }
    // fileWatch 每渲染都是新对象（useFileWatch 未 useMemo），补上会让本回调每渲染重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [text, fileName, spec, toast]);

  const handleSave = useCallback(async () => {
    // 1) 来自剪贴板卡片：回写数据库（主窗口经 history-item-updated 事件刷新）
    if (effectiveSourceId) {
      setIsSaving(true);
      try {
        await invoke("update_history", { id: effectiveSourceId, text });
        setInitialContent(text);
        // 用「此刻的文本」判脏：await 期间用户可能又改了（不能无条件置干净）
        setIsDirty(latestTextRef.current !== text);
        setAutoSaveError(false); // 手动存成功说明目标可写，清掉自动保存的失败标记
        toast("已保存", "success");
      } catch (e: unknown) {
        const msg = e instanceof Error ? e.message : String(e);
        toast("保存失败: " + msg, "error");
      } finally {
        setIsSaving(false);
      }
      return;
    }
    // 2) 无文件路径：另存为（弹系统对话框可能停很久，不算「保存中」）
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
      setIsSaving(true); // 冲突弹窗期间不算「保存中」——对话框可能停很久
      // 走后端命令而不是 fs 插件：外部打开的文件不在 fs scope 里，插件会直接拒
      // （forbidden path … allow-write-file）。读取本来就走 read_text_file_full，写跟上。
      await invoke("write_text_file_full", { path: currentFilePath, text });
      setInitialContent(text);
      // 同上：写盘 await 期间用户可能又改了
      setIsDirty(latestTextRef.current !== text);
      setAutoSaveError(false); // 同上：手动存成功就不再报自动保存失败
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
    } finally {
      setIsSaving(false);
    }
    // 不能补 fileWatch：useFileWatch 没 useMemo 包返回值，每渲染都是新对象。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveSourceId, currentFilePath, text, toast, handleSaveAs]);

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

  // 关闭前保存：逻辑与取舍见 useCloseSave 的文件头（返回布尔 = 能否关，
  // 好让宿主在**全部**脏标签都处置成功后才关窗）
  const saveForClose = useCloseSave({
    effectiveSourceId,
    currentFilePath,
    text,
    fileWatch,
  });

  // code 类型：按 languageName 从 language-data 懒加载语言模式的那条 effect
  // 已移到 CodeDocument —— 它要用 useCodeMirrorEditor 返回的 reconfigureLanguage，
  // 而那个 hook 又依赖本 hook 的 text/loading，直接互相依赖会成环。
  // 这里只剩「语言 → 默认文件名扩展名」这半边，它不碰 CodeMirror。

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

  // 自动保存（1s 防抖）：三条不变量与依赖数组的坑见 useAutoSaveFile 的文件头
  useAutoSaveFile({
    enabled: autoSaveEnabled,
    text,
    baseline: initialContent,
    effectiveSourceId,
    currentFilePath,
    fileWatch,
    setIsSaving,
    setInitialContent,
    setIsDirty,
    setAutoSaveError,
  });

  return {
    text,
    initialContent,
    currentFilePath,
    docDir,
    fileName,
    effectiveSourceId,
    loading,
    isDirty,
    isSaving,
    autoSaveError,
    languageName,
    setLanguageName,
    handleDocChange,
    handlePastedImages,
    handleSave,
    handleSaveAs,
    handleOpen,
    handleReloadFromDisk,
    saveForClose,
  };
}
