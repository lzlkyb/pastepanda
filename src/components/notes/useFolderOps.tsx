/**
 * 文件夹的增删改与右键菜单构造（B1 #1）。
 *
 * 从 `FolderTree.tsx` 拆出来的原因很直接：合在一起 314 行，超了规则 #7 的 300。
 * 拆得开也因为两件事确实不同：这里是「改数据与拼菜单」，那边是「怎么画树」。
 *
 * 🔴 红线：无 AI。纯结构操作。
 */
import { useCallback } from "react";
import { FolderPlus, Pencil, Trash2, FolderInput, Library } from "lucide-react";
import type { MenuItem } from "@/components/ContextMenu";
import { useToast } from "@/components/Toast";
import { confirmDialog } from "@/lib/confirm";
import {
  folderCreate,
  folderDelete,
  folderDeleteImpact,
  folderMove,
  folderRename,
  type FolderFilter,
  type FolderNode,
  type NoteFolder,
} from "@/lib/api";

/** 子树高度（只有自己 = 1）。与后端 `folder_height` 同口径。 */
export function subtreeHeight(node: FolderNode): number {
  if (node.children.length === 0) return 1;
  return 1 + Math.max(...node.children.map(subtreeHeight));
}

/**
 * 可选的移动目标。**四类目标直接不列出**：
 * ① 自己；② 自己的后代（否则子树从根上断开，笔记不丢但永久看不见）；
 * ③ 当前父（移了等于没移）；④ 移过去会超深度上限的。
 * 后端仍会再校一道（导入 / MCP 不走 UI）。抽到模块级是为了能直接测。
 */
export function folderMoveTargets(
  node: FolderNode,
  folders: NoteFolder[],
  maxDepth: number,
): NoteFolder[] {
  const banned = new Set<string>();
  const collect = (n: FolderNode) => {
    banned.add(n.id);
    n.children.forEach(collect);
  };
  collect(node);

  const height = subtreeHeight(node);
  return folders.filter(
    (f) => !banned.has(f.id) && f.id !== node.parent_id && f.depth + height <= maxDepth,
  );
}

export function useFolderOps({
  folders,
  maxDepth,
  selected,
  onSelect,
  onChanged,
}: {
  folders: NoteFolder[];
  maxDepth: number;
  selected: FolderFilter;
  onSelect: (f: FolderFilter) => void;
  onChanged: () => void;
}) {
  const { toast } = useToast();

  /** 新建（顶层或子级）。名字用 prompt：一个单行输入不值一个弹层。 */
  const create = useCallback(
    async (parentId: string | null) => {
      const name = window.prompt(parentId ? "新子文件夹名称" : "新文件夹名称", "");
      if (name === null) return; // 用户取消
      if (!name.trim()) {
        toast("文件夹名不能为空", "error");
        return;
      }
      if (await folderCreate(name, parentId)) onChanged();
    },
    [onChanged, toast],
  );

  const rename = useCallback(
    async (node: FolderNode) => {
      const name = window.prompt("重命名文件夹", node.name);
      if (name === null || name === node.name) return;
      if (await folderRename(node.id, name)) onChanged();
    },
    [onChanged],
  );

  /**
   * 删除。**确认框必须写真数字**（几个子文件夹 / 几条笔记会变未分类）。
   *
   * 拉不到影响数就**直接中止**，不弹一个没数字的确认框——用户无法据此决定。
   */
  const remove = useCallback(
    async (node: FolderNode) => {
      const impact = await folderDeleteImpact(node.id);
      if (!impact) {
        toast("读取删除影响失败，已取消", "error");
        return;
      }
      const [subs, notes] = impact;
      const parts = [`删除文件夹「${node.name}」？`];
      if (subs > 0) parts.push(`它的 ${subs} 个子文件夹也会删除。`);
      if (notes > 0) parts.push(`里面的 ${notes} 条笔记会移到「未分类」（不会丢）。`);
      if (subs === 0 && notes === 0) parts.push("它是空的。");

      const ok = await confirmDialog({
        title: "删除文件夹",
        message: parts.join(""),
        confirmText: "删除",
      });
      if (!ok) return;
      if (await folderDelete(node.id)) {
        // 删的正好是当前选中的 → 退回全部，否则列表永远空着
        if (selected === node.id) onSelect("all");
        onChanged();
      }
    },
    [onChanged, onSelect, selected, toast],
  );

  const move = useCallback(
    async (node: FolderNode, targetId: string | null) => {
      if (await folderMove(node.id, targetId)) onChanged();
    },
    [onChanged],
  );

  /** 可选的移动目标，规则见 `folderMoveTargets`。 */
  const moveTargets = useCallback(
    (node: FolderNode): NoteFolder[] => folderMoveTargets(node, folders, maxDepth),
    [folders, maxDepth],
  );

  /**
   * 拼右键菜单。深度已达上限时「新建子文件夹」也不出现——
   * 先显示再报错是更差的做法（同 A 阶段 file 卡片不显「转为笔记」）。
   */
  const buildMenu = useCallback(
    (node: FolderNode): MenuItem[] => {
      const items: MenuItem[] = [];
      if (node.depth < maxDepth) {
        items.push({
          icon: <FolderPlus size={14} />,
          label: "新建子文件夹",
          onClick: () => void create(node.id),
        });
      }
      items.push({
        icon: <Pencil size={14} />,
        label: "重命名",
        onClick: () => void rename(node),
      });

      const children: MenuItem[] = [];
      // 已在顶层的就不给「移到顶层」（无意义项比没有更差）
      if (node.parent_id !== null) {
        children.push({
          icon: <Library size={13} />,
          label: "移到顶层",
          onClick: () => void move(node, null),
        });
      }
      for (const t of moveTargets(node)) {
        children.push({
          icon: <FolderInput size={13} />,
          label: t.name,
          onClick: () => void move(node, t.id),
          separator: children.length === 1 && node.parent_id !== null,
        });
      }
      if (children.length > 0) {
        items.push({ icon: <FolderInput size={14} />, label: "移动到…", children });
      }

      items.push({
        icon: <Trash2 size={14} />,
        label: "删除",
        onClick: () => void remove(node),
        danger: true,
        separator: true,
      });
      return items;
    },
    [create, maxDepth, move, moveTargets, remove, rename],
  );

  return { create, rename, buildMenu };
}
