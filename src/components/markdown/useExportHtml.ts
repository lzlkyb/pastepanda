/**
 * 「导出为 HTML（分享）」：组装 → 选路径 → 落盘。
 *
 * 组装（渲染 + 样式 + 主题变量快照）在 `lib/markdown/exportBuild.ts`，
 * 与「导出 PDF」共用同一份——两条导出路排版不会漂。本文件只负责
 * 落盘这一段：saveDialog 选路径、writeTextFile 写盘、toast 反馈。
 */
import { useCallback, useRef, useState } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { writeTextFile } from "@tauri-apps/plugin-fs";
import { buildStandaloneDoc, type StandaloneDocInput } from "@/lib/markdown/exportBuild";
import { errText } from "@/lib/utils";
import { useToast } from "@/components/Toast";

export function useExportHtml(input: StandaloneDocInput) {
  const { toast } = useToast();
  const [exporting, setExporting] = useState(false);
  // state 更新是异步的，快速双击可能在重渲染前就进来第二次
  const busyRef = useRef(false);

  const exportHtml = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setExporting(true);
    try {
      const { doc, title, warnings } = await buildStandaloneDoc(input);
      if (!doc) {
        toast("文档是空的，没有可导出的内容", "error");
        return;
      }

      const path = await saveDialog({
        defaultPath: `${title}.html`,
        filters: [{ name: "HTML 文件", extensions: ["html"] }],
      });
      if (!path) return;

      await writeTextFile(path, doc);
      if (warnings.length > 0) {
        toast(`已导出，但有 ${warnings.length} 项提示：${warnings[0]}`, "success");
      } else {
        toast("已导出到 " + path, "success");
      }
    } catch (e) {
      toast("导出失败：" + errText(e, "未知错误"), "error");
    } finally {
      busyRef.current = false;
      setExporting(false);
    }
  }, [input, toast]);

  return { exportHtml, exporting };
}
