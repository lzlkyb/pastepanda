/**
 * 「导出为 PDF（打印）」：与 HTML 导出**同一份**单文件文档（buildStandaloneDoc），
 * 但不落盘——塞进隐藏 iframe 调起系统打印对话框，用户在对话框里选
 * 「另存为 PDF / Microsoft Print to PDF」。
 *
 * 为什么走打印而不是直接生成 PDF：Tauri v2 没有跨平台的 printToPDF API，
 * WebView2/WKWebView 的系统打印对话框是唯一免依赖、免新 Rust 插件的通路，
 * 也是 MarkText / cherry-markdown 的同款做法。打印版式（隐藏工具条、宽版式、
 * 表格防跨页断行）由 exportDoc.ts 的 SHELL_CSS @media print 段提供。
 */
import { useCallback, useRef, useState } from "react";
import { buildStandaloneDoc, type StandaloneDocInput } from "@/lib/markdown/exportBuild";
import { errText } from "@/lib/utils";
import { useToast } from "@/components/Toast";

/**
 * 隐藏 iframe 打印。srcdoc 与应用同源，data URI 字体/图片直接可用；
 * 等 document.fonts.ready 再调 print，避免首印落在回退字体上。
 */
function printStandaloneDoc(doc: string): void {
  const iframe = document.createElement("iframe");
  iframe.setAttribute("aria-hidden", "true");
  iframe.title = "打印预览";
  Object.assign(iframe.style, {
    position: "fixed",
    right: "0",
    bottom: "0",
    width: "0",
    height: "0",
    border: "0",
    visibility: "hidden",
  });
  const remove = () => window.setTimeout(() => iframe.remove(), 300);
  iframe.addEventListener("load", () => {
    const win = iframe.contentWindow;
    if (!win) {
      remove();
      return;
    }
    // afterprint：对话框关闭（含取消）后清掉 iframe；个别 WebView 不派发 → 定时兜底
    win.addEventListener("afterprint", remove);
    window.setTimeout(remove, 120_000);
    const start = () => {
      win.focus();
      win.print();
    };
    if (win.document.fonts?.ready) {
      win.document.fonts.ready.then(start).catch(start);
    } else {
      start();
    }
  });
  iframe.srcdoc = doc;
  document.body.appendChild(iframe);
}

export function useExportPdf(input: StandaloneDocInput) {
  const { toast } = useToast();
  const [exporting, setExporting] = useState(false);
  // 防重复点（同 useExportHtml）：state 异步更新，快速双击会重入
  const busyRef = useRef(false);

  const exportPdf = useCallback(async () => {
    if (busyRef.current) return;
    busyRef.current = true;
    setExporting(true);
    try {
      const { doc, warnings } = await buildStandaloneDoc(input);
      if (!doc) {
        toast("文档是空的，没有可导出的内容", "error");
        return;
      }
      printStandaloneDoc(doc);
      // 触发在菜单、结果不在页面上（打印对话框是系统 UI）——必须给一条
      // 同域反馈（规则 15）：对话框没弹出来时用户至少知道该找谁
      if (warnings.length > 0) {
        toast(`已调起打印，但有 ${warnings.length} 项提示：${warnings[0]}`, "info");
      } else {
        toast("已调起打印对话框，目标选「另存为 PDF」即可", "info");
      }
    } catch (e) {
      toast("导出失败：" + errText(e, "未知错误"), "error");
    } finally {
      busyRef.current = false;
      setExporting(false);
    }
  }, [input, toast]);

  return { exportPdf, exporting };
}
