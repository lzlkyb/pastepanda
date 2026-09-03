/**
 * NoteVaultRows.tsx —— 设置·数据管理里的两行：笔记的 Markdown 目录导出 / 导入（B1 #5 / D1）。
 *
 * 单独成件而不是往 GeneralTab 里堆：那个文件已经 1100+ 行。
 *
 * ❗ 文案必须与上面那两行分开：那两行是**历史记录的 JSON**，这两行是**笔记的目录**。
 *   不写清楚的话，用户会以为导了一份就什么都备份了。
 *
 * 逻辑在 `useNoteVaultOps`（A-61 抽出）：知识模式中栏的「⋯」溢出菜单是第二个入口，
 * 而导入后的六类 toast（失败 / 平接 / 重名 / 墓碑 / 清理 / 成功）写两份必定漏一类。
 * 本文件现在只负责设置页那两行的**外观**。
 *
 * 🔴 红线：无 AI。导出导入只在本机文件系统与本机 SQLite 之间走。
 */
import { useNoteVaultOps } from "@/hooks/useNoteVaultOps";
import styles from "../Settings.module.css";

export function NoteVaultRows({ onImported }: { onImported?: () => void }) {
  const { busy, exportDir, importDir } = useNoteVaultOps(onImported);

  return (
    <>
      <div className={styles.sRow}>
        <span
          className={styles.sRowIcon}
          style={{ background: "linear-gradient(135deg, #8B5CF6, #6D28D9)" }}
        >
          📝
        </span>
        <div className={styles.sRowBody}>
          <div className={styles.sRowLabel}>导出笔记为 Markdown 目录</div>
          <div className={styles.sRowDesc}>
            可直接当 Obsidian vault 打开；重复导出到同一目录会清理已删笔记留下的旧文件
          </div>
        </div>
        <button
          className={styles.sAction}
          onClick={() => void exportDir()}
          disabled={busy !== null}
        >
          {busy === "export" ? <span className={styles.sActionLoading}>导出中…</span> : "导出"}
        </button>
      </div>

      <div className={styles.sRow}>
        <span
          className={styles.sRowIcon}
          style={{ background: "linear-gradient(135deg, #10B981, #047857)" }}
        >
          📂
        </span>
        <div className={styles.sRowBody}>
          <div className={styles.sRowLabel}>从 Markdown 目录导入</div>
          <div className={styles.sRowDesc}>只新增与更新，不会删除现有笔记</div>
        </div>
        <button
          className={styles.sAction}
          onClick={() => void importDir()}
          disabled={busy !== null}
        >
          {busy === "import" ? <span className={styles.sActionLoading}>导入中…</span> : "导入"}
        </button>
      </div>
    </>
  );
}
