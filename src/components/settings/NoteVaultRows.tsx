/**
 * NoteVaultRows.tsx —— 设置·数据管理里的两行：笔记的 Markdown 目录导出 / 导入（B1 #5 / D1）。
 *
 * 单独成件而不是往 GeneralTab 里堆：那个文件已经 1100+ 行，且本功能自己就带状态。
 *
 * ❗ 文案必须与上面那两行分开：那两行是**历史记录的 JSON**，这两行是**笔记的目录**。
 *   不写清楚的话，用户会以为导了一份就什么都备份了。
 *
 * 🔴 红线：无 AI。导出导入只在本机文件系统与本机 SQLite 之间走。
 */
import { useCallback, useState } from "react";
import { useToast } from "@/components/Toast";
import { confirmDialog } from "@/lib/confirm";
import { noteExportDir, noteImportDir } from "@/lib/api";
import styles from "../Settings.module.css";

export function NoteVaultRows({ onImported }: { onImported?: () => void }) {
  const { toast } = useToast();
  const [busy, setBusy] = useState<"export" | "import" | null>(null);

  const pickDir = useCallback(async (title: string): Promise<string | null> => {
    const { open } = await import("@tauri-apps/plugin-dialog");
    const picked = await open({ directory: true, multiple: false, title });
    return typeof picked === "string" ? picked : null;
  }, []);

  const handleExport = useCallback(async () => {
    const dir = await pickDir("选一个空目录存放导出的笔记");
    if (!dir) return;
    setBusy("export");
    const rep = await noteExportDir(dir);
    setBusy(null);
    if (!rep) return; // api 层已弹错（规则 #15.3）

    // 删文件是不可逆的，所以**删了就必须说**（规则 #15.3）。
    // 不弹事前确认：删除条件是三条件白名单（带 pastepanda_id 且 id 已不在库里），
    // 用户自己写的 `.md` 碰不到，而导出本来是一步操作。
    if (rep.removed.length > 0) {
      toast(
        `同时清理了 ${rep.removed.length} 个已删笔记留下的旧文件：${rep.removed
          .slice(0, 3)
          .join("；")}`,
        "warning",
      );
    }

    // 报真数字而不是「完成」：导了几篇是用户唯一能拿来校对的东西
    toast(`已导出 ${rep.notes} 篇笔记到 ${rep.folders} 个文件夹`, "success");
  }, [pickDir, toast]);

  const handleImport = useCallback(async () => {
    const dir = await pickDir("选一个 Markdown 目录（可以是 Obsidian vault）");
    if (!dir) return;
    // 导入会改库里的笔记，先说清楚它会做什么、不会做什么
    const ok = await confirmDialog({
      title: "从 Markdown 目录导入",
      message:
        "将扫描该目录下的全部 .md 文件。导入是合并：只新增与更新，不会删除你现有的笔记。" +
        "被更新的笔记会自动留一份导入前的版本，可以在笔记的「历史」里回退。",
      confirmText: "开始导入",
    });
    if (!ok) return;

    setBusy("import");
    const rep = await noteImportDir(dir);
    setBusy(null);
    if (!rep) return;

    let msg = `新增 ${rep.created} 篇、更新 ${rep.updated} 篇`;
    if (rep.skipped > 0) msg += `、跳过 ${rep.skipped} 个文件`;

    // 失败的文件单独报，不混在成功数里面（规则 #15.3：失败不静默）。
    // 后端现在把**原因**也带在每条里了（形如 `A/B/x.md：文件过大（…）`），
    // 所以这里不能再写死「读不了」——大文件、库写失败都走这条路。
    if (rep.failed.length > 0) {
      toast(
        `${rep.failed.length} 个文件没导进来：${rep.failed.slice(0, 3).join("；")}`,
        "error",
      );
    }

    // 平接与另建都是「成功了，但结果与你目录里看到的不一样」，
    // 既不能当错误报、也不能混进那句成功里默默吐掉，所以单独一条 warning。
    if (rep.flattened > 0) {
      toast(
        `${rep.flattened} 篇的目录超过 ${rep.max_depth} 层，已平接到第 ${rep.max_depth} 层文件夹`,
        "warning",
      );
    }
    if (rep.collided.length > 0) {
      toast(
        `${rep.collided.length} 篇重名，已各建一条而不是互相覆盖：${rep.collided
          .slice(0, 3)
          .join("；")}`,
        "warning",
      );
    }

    // 墓碑：文件对应的笔记已在回收站。不报的话用户会以为文件没导进来，
    // 而且会去找一个不存在的失败原因——它实际上是被有意跳过的。
    if (rep.in_trash.length > 0) {
      toast(
        `${rep.in_trash.length} 个文件对应的笔记在回收站里，已跳过（要找回请去回收站恢复）：${rep.in_trash
          .slice(0, 3)
          .join("；")}`,
        "warning",
      );
    }

    toast(msg, "success");
    onImported?.();
  }, [pickDir, toast, onImported]);

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
          onClick={() => void handleExport()}
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
          onClick={() => void handleImport()}
          disabled={busy !== null}
        >
          {busy === "import" ? <span className={styles.sActionLoading}>导入中…</span> : "导入"}
        </button>
      </div>
    </>
  );
}
