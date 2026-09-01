import { describe, it, expect } from "vitest";
import { buildFolderTree, type NoteFolder, type FolderNode } from "@/lib/api/noteFolders";
import { subtreeHeight, folderMoveTargets } from "@/components/notes/useFolderOps";

/** 造一条文件夹记录。只有树形逻辑关心 id / parent_id / depth。 */
function f(id: string, parent_id: string | null, depth: number): NoteFolder {
  return {
    id,
    name: id,
    parent_id,
    sort_order: 0,
    created_at: "2026-09-01 00:00:00",
    note_count: 0,
    depth,
  };
}

/**
 * a ── a1 ── a11
 * b ── b1
 * 深度上限按后端 MAX_FOLDER_DEPTH = 3。
 */
const FLAT: NoteFolder[] = [
  f("a", null, 1),
  f("a1", "a", 2),
  f("a11", "a1", 3),
  f("b", null, 1),
  f("b1", "b", 2),
];
const MAX_DEPTH = 3;

/** 从树里按 id 找节点。 */
function find(nodes: FolderNode[], id: string): FolderNode {
  for (const n of nodes) {
    if (n.id === id) return n;
    const hit = findOrNull(n.children, id);
    if (hit) return hit;
  }
  throw new Error(`节点不存在: ${id}`);
}
function findOrNull(nodes: FolderNode[], id: string): FolderNode | null {
  for (const n of nodes) {
    if (n.id === id) return n;
    const hit = findOrNull(n.children, id);
    if (hit) return hit;
  }
  return null;
}

describe("buildFolderTree", () => {
  it("按 parent_id 还原层级", () => {
    const roots = buildFolderTree(FLAT);
    expect(roots.map((r) => r.id)).toEqual(["a", "b"]);
    expect(roots[0].children.map((c) => c.id)).toEqual(["a1"]);
    expect(roots[0].children[0].children.map((c) => c.id)).toEqual(["a11"]);
  });

  it("空输入返回空数组", () => {
    expect(buildFolderTree([])).toEqual([]);
  });

  it("父不在集内的孤岛升为根，绝不静默丢弃", () => {
    // 只有子、没有父（父被并发删除 / 分页截断都可能造成）
    const orphanFlat = [f("x1", "missing-parent", 2), f("a", null, 1)];
    const roots = buildFolderTree(orphanFlat);
    expect(roots.map((r) => r.id).sort()).toEqual(["a", "x1"]);
  });

  it("不改动入参对象（children 挂在副本上）", () => {
    const input = [f("a", null, 1)];
    buildFolderTree(input);
    expect("children" in input[0]).toBe(false);
  });
});

describe("subtreeHeight", () => {
  it("叶子高度为 1", () => {
    const roots = buildFolderTree(FLAT);
    expect(subtreeHeight(find(roots, "a11"))).toBe(1);
    expect(subtreeHeight(find(roots, "b1"))).toBe(1);
  });

  it("三层子树高度为 3", () => {
    const roots = buildFolderTree(FLAT);
    expect(subtreeHeight(find(roots, "a"))).toBe(3);
    expect(subtreeHeight(find(roots, "a1"))).toBe(2);
  });
});

describe("folderMoveTargets", () => {
  it("排除自己、自己的后代、当前父，以及会超深度的目标", () => {
    const roots = buildFolderTree(FLAT);
    // a1 高度 2，父是 a：目标深度必须 ≤1，所以 b1(depth 2) 也出局
    const targets = folderMoveTargets(find(roots, "a1"), FLAT, MAX_DEPTH);
    expect(targets.map((t) => t.id)).toEqual(["b"]);
  });

  it("叶子高度 1，深度 2 的文件夹也能收", () => {
    const roots = buildFolderTree(FLAT);
    const targets = folderMoveTargets(find(roots, "a11"), FLAT, MAX_DEPTH);
    expect(targets.map((t) => t.id).sort()).toEqual(["a", "b", "b1"]);
  });

  it("整棵子树移不动时返回空数组，而不是给一个非法目标", () => {
    const roots = buildFolderTree(FLAT);
    // a 高度 3，任何目标 depth+3 都 >3
    expect(folderMoveTargets(find(roots, "a"), FLAT, MAX_DEPTH)).toEqual([]);
  });
});
