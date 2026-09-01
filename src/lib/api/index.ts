/**
 * API 模块统一入口 — barrel re-export
 * 保持 `import { xxx } from "@/lib/api"` 导入路径不变
 */

// 粘贴引擎
export { pasteText, pasteTextGuarded, pasteRich, pasteRichGuarded, pasteImage, copyOnly, copyImageOnly, copyRichOnly, copyFiles, copyItemToClipboard, saveForeground, toggleWindow } from "./paste";

// 缓存管理
export { getStats, getStatsDetail, fetchCounts, fetchSidebarCounts, invalidateCountsCache, clearImageCaches } from "./cache";
export type { Stats, StatsDetail, DailyCount, SidebarCounts } from "./cache";

// 图片
export { getImageDataUrl, getImageBase64, dataUrlToBlob, getImageThumbnail, getImageInfo, ocrImage, ocrImageCached } from "./images";
export type { OcrResult, OcrLine, OcrWord } from "./images";

// 历史记录
export { loadMoreHistory, deleteHistory, togglePin, searchHistory, restoreDeleted } from "./history";
export type { SearchFilters } from "./history";

// 链接摘要（v6.4 A）
export { fetchUrlSummary } from "./url";
export type { UrlSummary } from "./url";

// 云端 AI（注意：没有读取密钥的接口，只有 set / has / clear）
export {
  aiGetConfig,
  aiSetConfig,
  aiSetKey,
  aiHasKey,
  aiClearKey,
  aiListProviders,
  aiListActions,
  aiListContentTypes,
  aiListCustomActions,
  aiSaveCustomAction,
  aiDeleteCustomAction,
  aiReorderCustomActions,
  aiPreviewCustom,
  // v6.4 AI 面板 v2：per-provider 配置 + 自定义服务商多实例
  aiGetProviderConfig,
  aiSaveCustomProvider,
  aiDeleteCustomProvider,
  aiGetUsage,
  aiListUsageLog,
  aiGetUsageStats,
  aiClearUsageLog,
  aiTestConnection,
  aiRun,
} from "./ai";
export type {
  AiConfig,
  AiProtocol,
  AiModelSpec,
  AiProviderInfo,
  AiActionMeta,
  AiActionOptionSpec,
  AiCustomAction,
  AiContentTypeOption,
  AiUsage,
  AiUsageDaily,
  AiUsageLogRow,
  AiUsageByAction,
  AiUsageStats,
  AiTestResult,
  AiRunResponse,
  // v6.4 AI 面板 v2
  ProviderConfigValue,
  CustomProviderInput,
} from "./ai";

// 依次粘贴 / 索引粘贴
export { sequentialPaste, indexPaste } from "./sequential";

// 剪贴板栈
export { toggleStackMode, exitStack, stackPasteNext, stackPasteAll, isStackPasteAllRunning, abortStackPasteAll, stackAutoSplitAndPasteFirst } from "./stack";

// 分组
export { fetchGroups, createGroup, updateGroup, deleteGroup, reorderGroups, moveToGroup } from "./groups";

// 标签
export { fetchTags, createTag, updateTag, deleteTag, setItemTags, addItemTags, removeItemTags, getItemsWithTags, confirmAutoTags } from "./tags";

// 笔记（知识库 A 阶段）
export {
  noteCreate,
  noteUpdate,
  noteDelete,
  noteGet,
  noteTouch,
  noteList,
  noteByHistory,
  fetchNoteHistoryIds,
  noteSearch,
  noteSearchRelevant,
  noteSetTags,
  noteCount,
  noteCountFiltered,
  noteGroupCounts,
} from "./notes";
export type { Note } from "./notes";

// 笔记文件夹（B1 #1）
export {
  folderList,
  folderUnfiledCount,
  folderMaxDepth,
  folderDeleteImpact,
  folderCreate,
  folderRename,
  folderMove,
  folderDelete,
  noteSetFolder,
  buildFolderTree,
} from "./noteFolders";
export type { NoteFolder, FolderFilter, FolderNode } from "./noteFolders";

// 笔记轻量 AI（B1 ＋轻量 AI）——只是落库，模型调用在变换枢纽
export { noteSetSummary, noteAddAiTags, noteConfirmAiTags } from "./noteAi";

// 今日速记（B2 #3 / D11）
export {
  noteAppendDaily,
  noteDailyDates,
  noteDailyEarliest,
  noteDailyToday,
} from "./noteDaily";
export type { DailyAppend } from "./noteDaily";

// Markdown 目录导出 / 导入（B1 #5 / D1）
export { noteExportDir, noteImportDir, noteMarkdown } from "./noteVault";
export type { ExportReport, ImportReport } from "./noteVault";

// 版本快照 + 恢复（B1 #4 / D8）
export { noteRevisionList, noteRevisionGet, noteRestore } from "./noteRevisions";
export type { NoteRevision, NoteRevisionMeta } from "./noteRevisions";

// 待沉淀区（知识库 A 阶段）
export {
  kbInboxList,
  kbInboxCount,
  kbInboxGroupCounts,
  kbInboxDismiss,
  kbInboxUndismiss,
} from "./kbInbox";
export type { InboxCandidate, InboxReason } from "./kbInbox";

// 自动收录影子运行（只度量，不收录）
export { kbShadowRun, kbShadowStats, kbShadowClear } from "./kbShadow";
export type { ShadowStats } from "./kbShadow";

// 应用信息
export { getAppVersion, getAppName } from "./app";

// 动作使用日志（v6.0 action_events：记录动作选择，只存本机、可一键清空）
export {
  logActionEvent,
  logPasteEvent,
  actionEventStats,
  actionEventClear,
  actionRecommendWeights,
  actionRecommendSceneWeights,
  actionDismissAdd,
  actionDismissals,
  actionLearningsClear,
} from "./actionEvents";
export type {
  ActionEvent,
  ActionOutcome,
  ActionEventStats,
  ActionEventCount,
  ActionWeightRow,
  SceneWeightRow,
  ActionDismissal,
} from "./actionEvents";

// 初始化
export { initBackend } from "./init";
