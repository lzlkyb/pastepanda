/**
 * API 模块统一入口 — barrel re-export
 * 保持 `import { xxx } from "@/lib/api"` 导入路径不变
 */

// 粘贴引擎
export { pasteText, pasteImage, pasteRich, copyOnly, copyImageOnly, copyRichOnly, copyFiles, copyItemToClipboard, saveForeground, toggleWindow } from "./paste";

// 缓存管理
export { getStats, getStatsDetail, fetchCounts, fetchSidebarCounts, invalidateCountsCache, clearImageCaches } from "./cache";
export type { Stats, StatsDetail, DailyCount, SidebarCounts } from "./cache";

// 图片
export { getImageDataUrl, getImageBase64, dataUrlToBlob, getImageThumbnail, getImageInfo, ocrImage } from "./images";
export type { OcrResult, OcrLine, OcrWord } from "./images";

// 历史记录
export { loadMoreHistory, deleteHistory, togglePin, searchHistory } from "./history";
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
export { toggleStackMode, exitStack, stackPasteNext, stackPasteAll, isStackPasteAllRunning, abortStackPasteAll } from "./stack";

// 分组
export { fetchGroups, createGroup, updateGroup, deleteGroup, reorderGroups, moveToGroup } from "./groups";

// 标签
export { fetchTags, createTag, updateTag, deleteTag, setItemTags, addItemTags, removeItemTags, getItemsWithTags, confirmAutoTags } from "./tags";

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
