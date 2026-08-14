/**
 * anyDialogOpen 的契约：**本 store 里任何一个弹窗开着，它都必须返回 true**。
 *
 * 这个函数是 App.tsx 全局键盘守卫的唯一依据：返回 false 就意味着
 * Delete / Backspace / Ctrl+A 等列表级按键会穿透弹窗打到主窗口的卡片上——
 * 之前就是因为守卫里手写枚举、漏了 editorItem，导致开着卡片编辑弹框按 Delete
 * 直接删掉了主窗口选中的卡片。
 */
import { describe, it, expect, beforeEach } from "vitest";
import { useDialogStore, anyDialogOpen } from "@/stores/dialogStore";
import type { HistoryItem } from "@/stores/appStore";

/** 只用到 id，其余字段与本用例无关 */
const ITEM = { id: "x1" } as HistoryItem;

/** 把 store 恢复到“全部关闭” */
function closeAll() {
  useDialogStore.setState({
    editorItem: null,
    hubItem: null,
    chainText: null,
    chainEdit: null,
    learningsOpen: false,
    profileOpen: false,
    pasteGuard: null,
    milestone: null,
    quotaOpen: false,
  });
}

describe("anyDialogOpen（全局键盘守卫的唯一依据）", () => {
  beforeEach(closeAll);

  it("全部关闭时为 false（列表按键才能生效）", () => {
    expect(anyDialogOpen(useDialogStore.getState())).toBe(false);
  });

  // 逐个弹窗验：哪一个漏在 anyDialogOpen 外面，这里就会红
  const CASES: { name: string; open: () => void }[] = [
    { name: "卡片编辑弹框 editorItem", open: () => useDialogStore.setState({ editorItem: ITEM }) },
    { name: "变换枢纽 hubItem", open: () => useDialogStore.setState({ hubItem: ITEM }) },
    { name: "链运行 chainText", open: () => useDialogStore.setState({ chainText: "t" }) },
    { name: "链编辑 chainEdit", open: () => useDialogStore.setState({ chainEdit: { id: "c", name: "c", description: "", steps: [] } }) },
    { name: "学习记录 learningsOpen", open: () => useDialogStore.setState({ learningsOpen: true }) },
    { name: "画像 profileOpen", open: () => useDialogStore.setState({ profileOpen: true }) },
    {
      name: "粘贴守卫 pasteGuard",
      open: () =>
        useDialogStore.setState({
          pasteGuard: { text: "t", maskPreview: "m", targetApp: null, resolve: () => {} },
        }),
    },
    {
      name: "里程碑 milestone",
      open: () => useDialogStore.setState({ milestone: { kind: "count", value: 100 } as never }),
    },
    { name: "额度签到 quotaOpen", open: () => useDialogStore.setState({ quotaOpen: true }) },
  ];

  for (const c of CASES) {
    it(`${c.name} 开着时为 true`, () => {
      c.open();
      expect(anyDialogOpen(useDialogStore.getState())).toBe(true);
    });
  }
});
