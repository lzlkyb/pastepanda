/**
 * hooks/useFilteredItems.ts —— 列表数据源（筛选 + 排序后的条目）。
 *
 * 抽出来的原因是踩过一个真 bug：`CardList` 原本自己写
 *   `useMemo(() => getFilteredItems(), [history, searchKeyword, filterType, ...])`
 * 而 `getFilteredItems()` 是从 store 内部读状态的纯函数式取值——它读什么、
 * 依赖数组就必须列什么，**列漏一个就永远不重算**。原代码漏了 `searchResults`
 * （组件也没订阅它），于是后端搜索结果到达后列表不刷新：
 * 输入关键词那一刻 `searchResults` 还是 null，落到内存筛（只匹配
 * text / pinyin / content），后端返回后 memo 不重算，列表就停在那个结果上。
 *
 * 以前没暴露是因为后端能搜到的词内存筛基本也能搜到；而「截图 OCR 文本可搜」
 * 第一次造出「后端能找到、内存筛根本不可能找到」的情况（图片条目的 text 是
 * "[图片] WxH"、content 是 md5 文件名，关键词只在 OCR 文本里），bug 才显形。
 *
 * 收成一个 hook 就是为了让这份依赖清单只有一处、且可测（见
 * `__tests__/useFilteredItems.test.tsx`）。往 `getFilteredItems` 里加新的
 * 状态来源时，**同时往下面的依赖数组里加**。
 */
import { useMemo } from "react";
import { useAppStore, type HistoryItem } from "@/stores/appStore";

export function useFilteredItems(): HistoryItem[] {
  const getFilteredItems = useAppStore((s) => s.getFilteredItems);
  // 下面每一项都是 getFilteredItems() 内部会读的状态（含它自己的缓存键成分）。
  // 函数体里没有直接引用它们，exhaustive-deps 也就报"多余"——但它们是承重的。
  const history = useAppStore((s) => s.history);
  const historyVersion = useAppStore((s) => s.historyVersion);
  const searchKeyword = useAppStore((s) => s.searchKeyword);
  const searchResults = useAppStore((s) => s.searchResults);
  const filterType = useAppStore((s) => s.filterType);
  const timeFilter = useAppStore((s) => s.timeFilter);
  const sourceFilter = useAppStore((s) => s.sourceFilter);
  const groupFilter = useAppStore((s) => s.groupFilter);
  const selectedTagIds = useAppStore((s) => s.selectedTagIds);
  const workspace = useAppStore((s) => s.config.current_workspace);

  // eslint-disable-next-line react-hooks/exhaustive-deps
  return useMemo(() => getFilteredItems(), [
    getFilteredItems,
    history,
    historyVersion,
    searchKeyword,
    searchResults,
    filterType,
    timeFilter,
    sourceFilter,
    groupFilter,
    selectedTagIds,
    workspace,
  ]);
}
