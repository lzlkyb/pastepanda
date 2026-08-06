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
export { getImageDataUrl, getImageBase64, dataUrlToBlob, getImageThumbnail, getImageInfo } from "./images";

// 历史记录
export { loadMoreHistory, deleteHistory, togglePin, searchHistory } from "./history";
export type { SearchFilters } from "./history";

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

// 初始化
export { initBackend } from "./init";
