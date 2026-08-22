/**
 * 「列表数据源」的依赖正确性。
 *
 * 这是一个真实 bug 的回归测试：`CardList` 原本用
 *   `useMemo(() => getFilteredItems(), [history, searchKeyword, filterType, ...])`
 * 取列表，而依赖数组里**没有 `searchResults`**，组件也没订阅它。于是：
 *
 * 1. 输入关键词 → memo 重算，此刻后端请求还在飞，`searchResults` 是 null
 *    → 落到内存筛（只匹配 text / pinyin / content）
 * 2. 后端返回 → `setSearchResults` 更新 store
 * 3. **memo 不重算**（不是依赖、也没订阅）→ 列表永远停在第 1 步的结果
 *
 * 以前没暴露，是因为后端能搜到的词内存筛基本也能搜到，第 1 步就已经对了，
 * 后端结果只是个超集（覆盖未分页加载的记录）。而「截图 OCR 文本可搜」
 * 第一次造出「后端能找到、内存筛根本不可能找到」的情况——图片条目的
 * text 是 "[图片] WxH"、content 是 md5 文件名，关键词只在 OCR 文本里。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useAppStore, HistoryItem } from "@/stores/appStore";
import { useFilteredItems } from "@/hooks/useFilteredItems";

function makeItem(o: Partial<HistoryItem> & { id: string; text: string }): HistoryItem {
  return {
    type: "text" as const,
    time: "2026-01-01 12:00:00",
    content: "",
    pinned: false,
    source: "clipboard",
    workspace: "默认",
    ...o,
  };
}

beforeEach(() => {
  useAppStore.setState({
    history: [],
    searchKeyword: "",
    searchResults: null,
    searchResultsKey: "",
    filterType: "all",
    timeFilter: "all",
    sourceFilter: "",
    groupFilter: "all",
    selectedTagIds: [],
    _filterCache: null,
    config: { ...useAppStore.getState().config, current_workspace: "默认" },
  });
});

describe("useFilteredItems", () => {
  it("后端搜索结果到达后列表必须更新（内存筛匹配不到的关键词）", () => {
    // 图片条目：text 是占位、content 是 md5 文件名，都不含「控制台」——
    // 内存筛必然匹配不到，只有后端（image_ocr_fts）能命中
    const img = makeItem({
      id: "img-1",
      text: "[图片] 1860x915",
      type: "image",
      content: "C:\\img\\0039a52c.png",
    });
    useAppStore.setState({ history: [img], searchKeyword: "控制台", _filterCache: null });

    const { result } = renderHook(() => useFilteredItems());
    // 后端还没回来：内存筛匹配不到，空列表是对的
    expect(result.current).toHaveLength(0);

    act(() => {
      useAppStore.getState().setSearchResults([img], "k1");
    });

    // ← 修复前这里是 0：memo 没有 searchResults 依赖，永远不重算
    expect(result.current).toHaveLength(1);
    expect(result.current[0].id).toBe("img-1");
  });

  it("清空关键词后回到内存筛结果", () => {
    const a = makeItem({ id: "a", text: "苹果" });
    const b = makeItem({ id: "b", text: "香蕉" });
    useAppStore.setState({ history: [a, b], searchKeyword: "苹果", _filterCache: null });

    const { result } = renderHook(() => useFilteredItems());
    expect(result.current.map((i) => i.id)).toEqual(["a"]);

    act(() => {
      useAppStore.setState({ searchKeyword: "", searchResults: null, _filterCache: null });
    });
    expect(result.current).toHaveLength(2);
  });

  it("筛选条件变化会重算", () => {
    const t = makeItem({ id: "t", text: "文本" });
    const i = makeItem({ id: "i", text: "[图片] 1x1", type: "image", content: "x.png" });
    useAppStore.setState({ history: [t, i], _filterCache: null });

    const { result } = renderHook(() => useFilteredItems());
    expect(result.current).toHaveLength(2);

    act(() => {
      useAppStore.setState({ filterType: "image", _filterCache: null });
    });
    expect(result.current.map((x) => x.id)).toEqual(["i"]);
  });
});
