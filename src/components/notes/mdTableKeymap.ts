/**
 * 表格输入辅助的键位绑定（B1 #12）。纯逻辑在 `@/lib/mdTable`。
 *
 * 两个键：
 * - **Tab / Shift+Tab**：在表格行内跳下一/上一个单元格；
 * - **Enter**：在表头行（下一行不是分隔行）回车时自动补一行 `| --- | --- |`。
 *
 * ❗ **不在表格里时必须返回 false**，让 `indentWithTab` / 默认回车照常工作。
 *   这个扩展装在它们**之前**，抢错一个键比没这个功能更讨厌。
 */
import { keymap, type EditorView } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { isTableRow, nextCellCol, separatorRow } from "@/lib/mdTable";

/** 分隔行：只由 `|`、`-`、`:` 与空白组成。 */
function isSeparatorRow(line: string): boolean {
  return isTableRow(line) && /^[\s|:-]+$/.test(line) && line.includes("-");
}

export function mdTableKeymap(): Extension {
  return keymap.of([
    {
      key: "Tab",
      run: (view) => moveCell(view, 1),
    },
    {
      key: "Shift-Tab",
      run: (view) => moveCell(view, -1),
    },
    {
      key: "Enter",
      run: (view) => {
        const { state } = view;
        const pos = state.selection.main.head;
        const line = state.doc.lineAt(pos);
        if (!isTableRow(line.text) || isSeparatorRow(line.text)) return false;
        // 只在行尾回车时接管；行中间回车是拆行，不该多手
        if (pos !== line.to) return false;
        // 下一行已经是分隔行 ⇒ 这不是刚写完的表头，放行
        if (line.number < state.doc.lines) {
          const next = state.doc.line(line.number + 1);
          if (isSeparatorRow(next.text)) return false;
        }
        const sep = separatorRow(line.text);
        if (!sep) return false;

        view.dispatch({
          changes: { from: pos, insert: `\n${sep}\n` },
          selection: { anchor: pos + sep.length + 2 },
          userEvent: "input.complete",
        });
        return true;
      },
    },
  ]);
}

function moveCell(view: EditorView, dir: 1 | -1): boolean {
  const { state } = view;
  const sel = state.selection.main;
  if (!sel.empty) return false; // 有选区时 Tab 是缩进，不抢

  const line = state.doc.lineAt(sel.head);
  if (!isTableRow(line.text)) return false;

  const col = nextCellCol(line.text, sel.head - line.from, dir);
  if (col === null) return false; // 已到本行首/尾格 ⇒ 放行，走默认缩进

  view.dispatch({ selection: { anchor: line.from + col } });
  return true;
}
