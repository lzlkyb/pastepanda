/**
 * API 模块统一入口 — barrel re-export
 * 保持 `import { xxx } from "@/lib/api"` 导入路径不变
 */

// 粘贴引擎
export { pasteText, pasteImage, copyOnly, saveForeground, toggleWindow } from "./paste";

// 缓存管理
export { getStats, fetchCounts, invalidateCountsCache, clearImageCaches } from "./cache";
export type { Stats } from "./cache";

// 图片
export { getImageDataUrl, getImageBase64, dataUrlToBlob, getImageThumbnail, getImageInfo } from "./images";

// 历史记录
export { loadMoreHistory, deleteHistory, togglePin } from "./history";

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
