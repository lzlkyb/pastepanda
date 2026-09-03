/**
 * kbMoreMenu — 中栏「⋯」溢出菜单的菜单项（A-61 ③）。
 *
 * 纯函数，照项目现有的 `createCardMenuItems` 范式——不另造一个下拉组件：
 * 项目里的 `ContextMenu` 已经把 `CtxMenuCtx`（`(x, y, items) => void`）开出来了，
 * `Card` / `FolderTree` / `NoteList` 都在用它。
 *
 * 为何需要这个菜单：导入导出埋在设置页，而它们做的是**对知识库的事**——
 * 用知识库的人要为此离开知识库。
 */
import { useMemo } from "react";
import { Upload, Download, Trash2, Plug } from "lucide-react";
import type { MenuItem } from "@/components/ContextMenu";
import { useNoteVaultOps, type VaultBusy } from "@/hooks/useNoteVaultOps";
import { openSettingsTab } from "@/lib/openSettings";

export interface KbMoreMenuOpts {
  /** 导入/导出正在跑。跑着时两项都不给点（同时跑两个目录扫描没意义）。 */
  busy: VaultBusy;
  onExport: () => void;
  onImport: () => void;
  /** 切到回收站。 */
  onTrash: () => void;
  trashCount: number;
}

export function createKbMoreMenuItems({
  busy,
  onExport,
  onImport,
  onTrash,
  trashCount,
}: KbMoreMenuOpts): MenuItem[] {
  // 跑着的时候把 onClick 置空而不是不渲染这两项：菜单项突然消失比不能点更迷惑，
  // 而 `MenuItem` 没有 `disabled`——没 onClick 的项本来就不可交互（见 navigableSubIndexes）。
  const vaultBusy = busy !== null;
  return [
    {
      icon: <Upload size={14} />,
      label: busy === "import" ? "导入中…" : "从 Markdown 目录导入…",
      onClick: vaultBusy ? undefined : onImport,
    },
    {
      icon: <Download size={14} />,
      label: busy === "export" ? "导出中…" : "导出为 Markdown 目录…",
      onClick: vaultBusy ? undefined : onExport,
    },
    { icon: null, label: "", separator: true },
    {
      /**
       * 连接 AI 工具（MCP）。
       *
       * ❗ 跳到设置页的 MCP tab，而**不是把面板搬进一个弹窗**：
       *   `McpServerPanel` 需 8 个 props，全来自 `useMcpServer`，而那个 hook 带
       *   5s 轮询、`mcp-start-failed` 监听与一个「从成功转失败才提示一次」的 ref——
       *   两个实例会各自弹一次 toast。跳过去只有一个实例，而且那个 tab 不看就不轮询。
       */
      icon: <Plug size={14} />,
      label: "连接 AI 工具（MCP）…",
      onClick: () => openSettingsTab("mcp"),
    },
    { icon: null, label: "", separator: true },
    {
      // 回收站在侧栏里已经有一个入口，这里是第二个——**侧栏收起时那个就没了**。
      // 两个入口指向同一个 `folderFilter="trash"`，不是两套逻辑。
      icon: <Trash2 size={14} />,
      label: trashCount > 0 ? `回收站（${trashCount}）` : "回收站",
      onClick: onTrash,
    },
  ];
}

/**
 * 组装好的菜单项。
 *
 * 包成 hook 而不是让 `KnowledgeView` 自己拼：它刚从 975 行拆到 349，
 * 而这里需要 `useNoteVaultOps` + 一个 useMemo——那三行属于「组装溢出菜单」
 * 这个职责，不属于编排层。
 */
export function useKbMoreMenu({
  refreshAll,
  trashCount,
  onTrash,
}: {
  /** 导入完要重拉列表与侧栏（新增的笔记与文件夹都得出现）。 */
  refreshAll: () => void;
  trashCount: number;
  /** 切到回收站。必须是稳定引用，否则下面那个 useMemo 等于没包。 */
  onTrash: () => void;
}): MenuItem[] {
  const { busy, exportDir, importDir } = useNoteVaultOps(refreshAll);
  return useMemo(
    () =>
      createKbMoreMenuItems({
        busy,
        onExport: () => void exportDir(),
        onImport: () => void importDir(),
        onTrash,
        trashCount,
      }),
    [busy, exportDir, importDir, onTrash, trashCount],
  );
}
