import { useCallback, useRef, useMemo, useSyncExternalStore } from "react";
import { useAppStore } from "@/stores/appStore";
import { parseFilePaths, getImageOcrFullText, getImageBarcodes } from "@/lib/utils";
import { URL_SCHEME_RE, fileUrlToLocalPath } from "@/lib/url";
import { applicableTransforms, getTransform } from "@/lib/transforms";
import { extractNoteDraft } from "@/lib/notes/extract";
import { openNoteForCard } from "@/lib/notes/open";
import { openArticleForCard, isArticleCard, aiComposeArticleForCard } from "@/lib/notes/article";
import { togglePinAndDeposit } from "@/lib/notes/deposit";
import { isAiAvailable } from "@/lib/transforms/aiTransforms";
import { useDialogStore } from "@/stores/dialogStore";
import { createCardMenuItems } from "@/components/ContextMenu";
import { getEnabledRules, subscribeRules } from "@/lib/regexRules";
import { confirmAutoTags, removeItemTags, noteAppendDaily } from "@/lib/api";
import { useToast } from "@/components/Toast";
import { logger } from "@/lib/logger";
import { deleteHistory, copyItemToClipboard } from "@/lib/api";
import { pasteGuarded } from "@/lib/pasteGuard";
import { useActionEventLog } from "@/hooks/useActionEventLog";
import type { CardContextProps } from "@/components/card/cardTypes";
import { copyOcrTextToClipboard, copyBarcodesToClipboard } from "@/components/card/cardClipboard";

export function useCardContextMenu({ item, index, onEdit, onEditTags, onMoveToGroup, onQrCode, onRegexPreview, onManageRegexRules, ocrState, barcodeState }: CardContextProps) {
  const { toast } = useToast();

  /**
   * 当前条目在列表里的下标，给粘贴埋点用（v6.15）。
   *
   * **用 ref 而不是直接用 `index`**：下面的 `menuItems` 是 `useMemo` 缓存的，
   * 而 `index` 会随列表滚动/过滤频繁变。把 `index` 加进依赖数组会让每个列表项
   * 在每次位置变化时重建整个右键菜单；不加则埋点会记到**过期的下标**。
   * ref 两边都顺——menuItems 不用重算，读到的又永远是当前值。
   * （eslint 的 exhaustive-deps 当时真的揪住了这个 bug。）
   */
  const indexRef = useRef(index);
  indexRef.current = index;

  const hasUrl = URL_SCHEME_RE.test(item.text || "");

  // 前端长度防护：直接传全文 content 到后端，30MB 的粘贴会变成 30MB 的片段行，导致片段库永久卡死；
  // 超过 10 万字符（约 100KB）时截断并提示用户，不直接拒绝是为了仍能保留大部分内容可用
  const MAX_SNIPPET_LEN = 100000;
  const handleAddSnippet = useCallback(async () => {
    const full = item.text || "";
    const truncated = full.length > MAX_SNIPPET_LEN;
    const content = truncated ? full.slice(0, MAX_SNIPPET_LEN) : full;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("add_snippet", { name: item.text.slice(0, 30), content });
      toast(truncated ? "内容过长，已截取前 10 万字符并添加到片段库" : "已添加到片段库", "success");
    } catch (e) {
      logger.warn("添加片段失败", e);
      // 修复：添加失败此前完全静默，用户不知道操作没生效
      toast(`添加到片段库失败：${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }, [item.text, toast]);

  // 自动标签相关
  const hasAutoTags = useMemo(() =>
    (item.tags || []).some(t => t.source === "auto"),
  [item.tags]);
  const autoTagIds = useMemo(() =>
    (item.tags || []).filter(t => t.source === "auto").map(t => t.id),
  [item.tags]);

  const handleConfirmAutoTags = useCallback(async () => {
    try {
      await confirmAutoTags(item.id);
      toast("已确认自动标签", "success");
    } catch (e) {
      logger.warn("确认自动标签失败", e);
      // 修复：确认失败此前完全静默，标签状态未变却用户毫无感知
      toast(`确认自动标签失败：${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }, [item.id, toast]);

  const handleRemoveAutoTags = useCallback(async () => {
    try {
      if (autoTagIds.length > 0) {
        await removeItemTags([item.id], autoTagIds);
        toast("已移除自动标签", "success");
      }
    } catch (e) {
      logger.warn("移除自动标签失败", e);
      // 修复：移除失败此前完全静默，标签仍在却用户以为已移除
      toast(`移除自动标签失败：${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }, [item.id, autoTagIds, toast]);

  const handleOpenUrl = useCallback(async () => {
    try {
      // file:// 链接 opener 插件默认白名单不放行，转本地路径走后端命令打开
      const localPath = fileUrlToLocalPath(item.text || "");
      if (localPath) {
        const { invoke } = await import("@tauri-apps/api/core");
        await invoke("open_file_with_system", { path: localPath });
      } else {
        const { openUrl } = await import("@tauri-apps/plugin-opener");
        await openUrl(item.text);
      }
    } catch (e) {
      logger.warn("打开URL失败", e);
      // 修复：打不开时此前完全静默，用户点了没反应完全不知道发生了什么
      toast(`打开失败：${e instanceof Error ? e.message : String(e)}`, "error");
    }
  }, [item.text, toast]);

  // 文件操作目标路径：
  //  - file_path 文本子类型：路径就在 item.text
  //  - file 类型：路径列表存在 item.content（JSON 数组），取第一个
  const subType = item.content_type || item.type;
  const isFilePath = item.type === "text" && subType === "file_path";
  const fileTarget = isFilePath
    ? (item.text || "").trim()
    : item.type === "file"
      ? (parseFilePaths(item.content || "")[0] || "").trim()
      : "";

  // file_path / file：系统级动作（复用 FileDetailDialog 已验证的后端命令，
  // 后端自带存在性检查与网络路径拦截，失败原因经 Err 字符串带回）
  const handleOpenFile = useCallback(async () => {
    if (!fileTarget) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_file_with_system", { path: fileTarget });
      toast("已用默认应用打开", "success");
    } catch (e) {
      toast(e?.toString?.() || "无法打开文件", "error");
    }
  }, [fileTarget, toast]);

  const handleRevealFile = useCallback(async () => {
    if (!fileTarget) return;
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("open_file_location", { path: fileTarget });
    } catch (e) {
      toast(e?.toString?.() || "无法打开文件夹", "error");
    }
  }, [fileTarget, toast]);

  const canQrCode = item.type === "text" && (hasUrl || (item.text || "").length <= 300);

  // 行为埋点：卡片右键的粘贴变换此前完全没记（只有变换中心记），
  // 于是“用户其实经常从右键用某个变换”这件事，推荐系统一无所知
  const logEvent = useActionEventLog(item.content_type || item.type, item.source, item.id);

  const handlePasteTransform = useCallback(async (transform: string) => {
    let text = item.text || "";
    const content = item.content || "";

    try {
      switch (transform) {
        // === 图片类型（依赖 item.content，含异步读取，不走注册表） ===
        case "md_image": {
          const imgPath = content || text;
          text = `![图片](${imgPath})`;
          break;
        }
        case "img_base64": {
          // 如果 content 是本地路径，尝试读取并转 base64
          if (content) {
            try {
              const { invoke } = await import("@tauri-apps/api/core");
              const b64: string = await invoke("read_file_as_base64", { path: content });
              text = `data:image/png;base64,${b64}`;
            } catch {
              // 兜底：粘贴路径
              text = content;
              toast("图片Base64转换失败，已粘贴路径", "warning");
            }
          }
          break;
        }

        // === 文件类型（依赖 item.content 解析路径数组，不走注册表） ===
        case "file_name": {
          const files = parseFilePaths(content);
          text = files.map((f: string) => f.split(/[/\\]/).pop() || f).join("\n");
          break;
        }
        case "file_dir": {
          const files = parseFilePaths(content);
          text = files.map((f: string) => {
            const idx = Math.max(f.lastIndexOf("/"), f.lastIndexOf("\\"));
            return idx >= 0 ? f.slice(0, idx) : ".";
          }).join("\n");
          break;
        }
        case "file_bslash": {
          const files = parseFilePaths(content);
          text = files.map((f: string) => f.replace(/\//g, "\\")).join("\n");
          break;
        }
        case "file_fslash": {
          const files = parseFilePaths(content);
          text = files.map((f: string) => f.replace(/\\/g, "/")).join("\n");
          break;
        }
        case "file_list": {
          const files = parseFilePaths(content);
          text = files.join("\n");
          break;
        }

        // === 文本变换：统一走变换注册表（与枢纽/右键同一数据源） ===
        default: {
          const t = getTransform(transform);
          if (!t) {
            toast("未知变换", "error");
            return;
          }
          const r = await t.run(text);
          if (!r.ok || !r.output) {
            toast(r.message ?? "无法转换", "error");
            return;
          }
          text = r.output;
        }
      }
      // U1：仅粘贴成功时弹成功提示（pasteGuarded 失败时已自行弹错误 toast）
      // v6.2 粘贴守卫：敏感内容先确认（脱敏后粘贴），目标应用感知
      const ok = await pasteGuarded(text);
      if (ok) {
        toast("已粘贴", "success");
        // 粘贴成功才记，与变换中心同口径（失败不算使用）
        logEvent(transform, "pasted");
      }
    } catch { toast("粘贴失败", "error"); }
  }, [item.text, item.content, toast, logEvent]);

  // 变换枢纽：当前内容是否有可用变换（json 数组 / 按列值 等），有才显示右键入口。
  //
  // **图片无条件显示**：它的 `text` 是空的，按这里算永远是 0 个变换；
  // 而枢纽打开后会先本地 OCR，识别出文字才知道能做什么——能不能做得打开了才算得出来。
  const hubAvailable = useMemo(
    () =>
      item.type === "image" ||
      applicableTransforms({
        text: item.text || "",
        contentType: subType,
        html: item.type === "doc" || item.type === "rich" ? item.content : undefined,
      }).length > 0,
    [item.text, item.content, item.type, subType],
  );
  const handleOpenHub = useCallback(() => {
    useDialogStore.getState().openHub(item);
  }, [item]);

  // 正则规则存在模块级可变缓存里，右键菜单的「正则替换」子菜单就是从它来的。
  // 订阅它而不是在菜单构建时偷偷读：规则一改就重算 menuItems —— 否则在
  // 「管理正则规则…」加/删/启停的规则不会出现在菜单里，得等别的原因触发这张卡重渲染。
  // getEnabledRules 返回的是引用稳定的共享快照，可以直接当 useSyncExternalStore 的快照用。
  const enabledRules = useSyncExternalStore(subscribeRules, getEnabledRules);

  // 转为笔记（知识库 A 阶段 · 规划 §8.1 3️⃣）。
  //
  // 初稿在这里算而不是点菜单时再算：算不出来（null）就要拿它决定菜单项要不要出现。
  const noteDraft = useMemo(() => extractNoteDraft(item, ocrState), [item, ocrState]);
  // 这张卡片已转过没——只读 store 里那个全量集合，不逐张发 IPC
  const hasNote = useAppStore((s) => s.noteHistoryIds.has(item.id));
  // 幂等判断与弹窗打开全在 openNoteForCard 里（规则 #11）——角标点击走同一条路
  /**
   * 追加到今日速记（B2 #3）。用与转笔记**同一份** `noteDraft.content`：
   * 它已经处理过图片 OCR、类型差异这些，另取一遍 `item.text` 会在图片卡片上追加出空段。
   */
  const handleAppendDaily = useCallback(async () => {
    if (!noteDraft) return;
    const r = await noteAppendDaily(noteDraft.content, item.source ?? null);
    if (!r) {
      toast("追加失败", "error");
      return;
    }
    // duplicate 不是错误，但也不能装作成功——否则用户以为记了两条
    toast(r.status === "duplicate" ? "这条刚记过" : "已追加到今日速记", "success");
  }, [noteDraft, item.source, toast]);

  const handleConvertToNote = useCallback(() => {
    void openNoteForCard(item, ocrState);
  }, [item, ocrState]);

  // 抓取全文存知识库（「文章 → 知识库」阶段 2）：只对纯链接卡片注入
  const handleFetchArticle = useCallback(() => {
    void openArticleForCard(item, toast);
  }, [item, toast]);

  // AI 清洗成文（阶段 4）：只有 AI 可用时才注入菜单（规则 16 门控）
  const handleAiCompose = useCallback(() => {
    void aiComposeArticleForCard(item, toast);
  }, [item, toast]);

  const menuItems = useMemo(() => createCardMenuItems({
    onEdit: (item.type === "text" || item.type === "diagram") && onEdit ? () => onEdit(item) : undefined,
    onEditTags: onEditTags ? () => onEditTags(item) : undefined,
    onMoveToGroup: onMoveToGroup ? () => onMoveToGroup(item) : undefined,
    onCopy: async () => {
      try {
        toast(await copyItemToClipboard(item), "success");
      } catch {
        toast("复制失败", "error");
      }
    },
    // 图片且有 OCR 文本时：右键「复制识别文字」（收口 copyOcrTextToClipboard）
    onCopyOcr: item.type === "image" && getImageOcrFullText(item, ocrState)
      ? () => void copyOcrTextToClipboard(item, ocrState, toast)
      : undefined,
    // 图片且解码出码时：右键「复制二维码/条码内容」（有码才出现，无码零可见）
    onCopyBarcodes: item.type === "image" && (getImageBarcodes(item, barcodeState)?.length ?? 0) > 0
      ? () => void copyBarcodesToClipboard(item, barcodeState, toast)
      : undefined,
    onPaste: async () => {
      // 按类型分派 + 粘贴信号回写统一走 pasteHistoryItem。
      // **这里此前没有 image / file 分支**：图片条目会粘出 "[图片] 1860x915" 占位文本、
      // 文件条目粘出裸文件名而不是完整路径（右键菜单的「粘贴到前台」是无条件项，
      // 图片/文件条目一样能点到）。托盘弹窗当年的 U33 修过同一个问题，只修了自己那份。
      const { pasteHistoryItem } = await import("@/lib/pasteItem");
      const { ok } = await pasteHistoryItem(item, indexRef.current);
      if (ok) toast("已粘贴", "success");
    },
    onPasteTransform: handlePasteTransform,
    onOpenHub: hubAvailable ? handleOpenHub : undefined,
    itemType: item.type,
    itemSubType: subType,
    onPin: async () => {
      // 星标动作收口：置顶持久化 + 自动沉淀（togglePinAndDeposit 内部带失败提示）
      await togglePinAndDeposit(item, ocrState, toast);
    },
    onDelete: () => { void deleteHistory([item.id]); },
    onAddSnippet: handleAddSnippet,
    onOpenUrl: hasUrl ? handleOpenUrl : undefined,
    onOpenFile: fileTarget ? handleOpenFile : undefined,
    onRevealFile: fileTarget ? handleRevealFile : undefined,
    onQrCode: canQrCode && onQrCode ? () => onQrCode(item) : undefined,
    canQrCode,
    onRegexPreview: item.type === "text" && onRegexPreview ? (ruleId: string) => onRegexPreview(item, ruleId) : undefined,
    regexRules: enabledRules,
    onManageRegexRules,
    onConfirmAutoTags: hasAutoTags ? handleConfirmAutoTags : undefined,
    onRemoveAutoTags: hasAutoTags ? handleRemoveAutoTags : undefined,
    // 转为笔记（知识库 A 阶段）。noteDraft 为 null 时**不注入回调** → 菜单里根本不出现这一项
    onConvertToNote: noteDraft ? handleConvertToNote : undefined,
    // 抓取全文存知识库（阶段 2）：纯链接卡且**还没转过笔记**才出现——
    // 已转过时点击只会打开旧笔记而不是抓取（幂等口径），菜单若仍写
    // 「抓取全文」就是说谎；打开旧笔记的入口由上面的「编辑笔记」承担。
    onFetchArticle: isArticleCard(item) && !hasNote ? handleFetchArticle : undefined,
    // AI 清洗成文（阶段 4）：AI 可用、有正文、且**还没转过笔记**才出现——
    // 已转过时点它只会借 AI 入口建出第二份（幂等在函数里兜底，菜单也不再撒谎）。
    onAiCompose: isAiAvailable() && noteDraft && !hasNote ? handleAiCompose : undefined,
    // 同一道门：抽不出正文的卡片（如 file）也没什么可追加的
    onAppendDaily: noteDraft ? () => void handleAppendDaily() : undefined,
    hasNote,
    hasUrl,
    hasAutoTags,
    pinned: item.pinned,
  }), [item, subType, hasUrl, fileTarget, canQrCode, hasAutoTags, toast, onEdit, onEditTags, onMoveToGroup, onQrCode, onRegexPreview, onManageRegexRules, handlePasteTransform, handleOpenHub, hubAvailable, handleAddSnippet, handleOpenUrl, handleOpenFile, handleRevealFile, handleConfirmAutoTags, handleRemoveAutoTags, ocrState, barcodeState, enabledRules, noteDraft, hasNote, handleConvertToNote, handleFetchArticle, handleAiCompose, handleAppendDaily]);

  return menuItems;
}
