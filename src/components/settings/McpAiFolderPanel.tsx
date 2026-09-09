/**
 * 由 AI 创建的文件夹 + 一键撤销（项目③）。
 *
 * # 为何是「可撤销」而不是「建之前弹窗确认」
 *
 * 确认弹窗的价值会随次数衰减到零（用户学会无脑点是），而撤销的价值不会。
 * 而且 MCP 的 `confirm` 参数是**模型自己填**的，根本不是用户确认；
 * 真正的用户确认只存在于客户端的授权弹窗，而那东西本应用不控制、
 * 用户还会点「always allow」。
 *
 * # 文案不能说「恢复原状」
 *
 * 撤销 = 删掉夹子、里面的东西升到父级。如果笔记本来在别的夹子里、
 * 被 AI 挑进来的，它**不会**回到原处（`note_revisions` 不存 `folder_id`，
 * 没数据源）。所以确认文案直接报它们会去哪里。
 */
import { useCallback, useEffect, useState } from "react";
import { confirmDialog } from "@/lib/confirm";
import { mcpAiFolders, mcpUndoAiFolder, type McpAiFolder } from "@/lib/api/mcp";
import styles from "../Settings.module.css";

export function McpAiFolderPanel({
  toast,
}: {
  toast: (msg: string, type?: "success" | "error" | "info", duration?: number) => void;
}) {
  const [rows, setRows] = useState<McpAiFolder[]>([]);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState("");

  const reload = useCallback(() => {
    void mcpAiFolders().then(setRows);
  }, []);

  useEffect(reload, [reload]);

  const undo = useCallback(
    async (row: McpAiFolder) => {
      // 去向直接写进确认文案：用户靠它判断要不要点确定。
      const where = row.depth > 1 ? "上一层文件夹" : "未分类";
      const ok = await confirmDialog({
        title: `撤销文件夹「${row.name}」？`,
        message:
          row.noteCount > 0
            ? `夹子会被删掉，里面的 ${row.noteCount} 篇笔记与子文件夹会移到${where}。\n` +
              `一篇都不会丢，但如果某篇本来在别的夹子里、是 AI 挑进来的，` +
              `它不会回到原处。`
            : `夹子是空的，直接删掉。`,
        confirmText: "撤销",
        variant: "danger",
      });
      if (!ok) return;
      setBusy(row.id);
      const done = await mcpUndoAiFolder(row.id);
      setBusy("");
      if (!done) return; // api 层已弹错（规则 #15.3）
      const [notes, folders] = done;
      toast(
        notes || folders
          ? `已撤销「${row.name}」，${notes} 篇笔记与 ${folders} 个子文件夹已移到${where}`
          : `已撤销「${row.name}」`,
        "success",
      );
      reload();
    },
    [reload, toast],
  );

  // 一个都没有就不渲染：给一个永远空的区只是噪声。
  if (rows.length === 0) return null;

  return (
    <div className={styles.mcpGuide}>
      <button type="button" className={styles.mcpGuideToggle} onClick={() => setOpen((v) => !v)}>
        {open ? "▾" : "▸"} 由 AI 创建的文件夹（{rows.length}）
      </button>

      {open && (
        <div className={styles.mcpGuideBody}>
          <ul className={styles.mcpFsList}>
            {rows.map((r) => (
              <li key={r.id} className={styles.mcpFsRow}>
                <span className={styles.mcpFsName}>{r.name}</span>
                <span className={styles.mcpFsCount}>{r.noteCount} 篇</span>
                <button
                  type="button"
                  className={styles.mcpFsClear}
                  disabled={busy === r.id}
                  onClick={() => void undo(r)}
                >
                  撤销
                </button>
              </li>
            ))}
          </ul>
          <p className={styles.mcpGuideNote}>
            撤销 = 删掉这个夹子，<b>里面的笔记与子文件夹都升到父级</b>（顶层则变未分类）。
            一篇笔记都不会丢。
            你自己改过名字或挑过位置的夹子仍然列在这里——
            它记的是「谁建的」，不是「谁最后改的」。
          </p>
        </div>
      )}
    </div>
  );
}
