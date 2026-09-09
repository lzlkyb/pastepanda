/**
 * 导出流程图（PNG / SVG / Mermaid / .panda）。
 *
 * 内嵌编辑器与全屏编辑器原本各存了一份逐字相同的 exportAs 与 dataUrlToText，
 * 这里收口成一份（规则 #11：公共逻辑单一数据源）。
 */
import { useCallback, useRef, useState, type RefObject } from "react";
import { save as saveDialog } from "@tauri-apps/plugin-dialog";
import { writeFile, writeTextFile } from "@tauri-apps/plugin-fs";
import { toPng, toSvg } from "html-to-image";
import { serializeDiagram, toMermaid, type DiagramDoc } from "@/lib/diagram/types";
import { errText } from "@/lib/utils";
import { useToast } from "@/components/Toast";

export type ExportKind = "png" | "svg" | "mermaid" | "panda";

/** 只要求画布句柄提供这两个方法，不从父组件 import 类型，避开循环依赖 */
interface ExportSource {
  getDoc: () => DiagramDoc;
  fitView: () => void;
}

const EXT: Record<ExportKind, string> = { png: "png", svg: "svg", mermaid: "mmd", panda: "panda" };

const FILTERS: Record<ExportKind, { name: string; extensions: string[] }[]> = {
  png: [{ name: "PNG 图片", extensions: ["png"] }],
  svg: [{ name: "SVG 矢量图", extensions: ["svg"] }],
  mermaid: [{ name: "Mermaid 源码", extensions: ["mmd", "txt"] }],
  panda: [{ name: "PastePanda 流程图", extensions: ["panda"] }],
};

/** html-to-image 的 toSvg 返回 data URL，得把它还原成 SVG 文本再写盘 */
function dataUrlToText(url: string): string {
  const B64 = "data:image/svg+xml;base64,";
  if (url.startsWith(B64)) {
    try {
      return atob(url.slice(B64.length));
    } catch {
      return url;
    }
  }
  const comma = url.indexOf(",");
  if (comma >= 0) {
    try {
      return decodeURIComponent(url.slice(comma + 1));
    } catch {
      return url.slice(comma + 1);
    }
  }
  return url;
}

/**
 * 返回 `[exportAs, exporting]`。
 *
 * exporting 是必需的：toPng 要内联字体、序列化成 foreignObject、再以 2 倍像素比解码，
 * 中等规模流程图上是秒级。旧实现里 onExport 的类型是 `(kind) => void`，菜单拿不到
 * 这个 Promise，点完"PNG 图片"、选完路径后界面完全静止若干秒 —— 最典型的反应是
 * 再点一次，于是两个 toPng 并发跑同一个 DOM 节点，还都会调 fitView() 互相打架。
 * busyRef 是双保险：state 更新是异步的，快速双击可能在重渲染前就进来第二次。
 */
export function useDiagramExport(
  canvasRef: RefObject<ExportSource | null>,
): [(kind: ExportKind) => Promise<void>, boolean] {
  const { toast } = useToast();
  const [exporting, setExporting] = useState(false);
  const busyRef = useRef(false);

  const exportAs = useCallback(
    async (kind: ExportKind) => {
      // 上一次还没完就直接丢掉本次请求（按钮已置忙，这里只防重渲染前的快速双击）。
      if (busyRef.current) return;
      const doc = canvasRef.current?.getDoc();
      if (!doc) return;
      busyRef.current = true;
      setExporting(true);
      try {
        const path = await saveDialog({
          defaultPath: `流程图.${EXT[kind]}`,
          filters: FILTERS[kind],
        });
        // 取消保存对话框也要复位——外层 finally 负责，这里直接 return 即可。
        if (!path) return;
        try {
          if (kind === "mermaid") {
            await writeTextFile(path, toMermaid(doc));
          } else if (kind === "panda") {
            await writeTextFile(path, serializeDiagram(doc));
          } else {
            const el = document.querySelector<HTMLElement>(".react-flow");
            if (!el) throw new Error("画布未就绪");
            const bg =
              getComputedStyle(el).getPropertyValue("--diagram-canvas-bg").trim() || "#0b1220";
            // 先整图适配视口，避免只截到可视区；再剔除控件/缩略图后截图
            canvasRef.current?.fitView();
            await new Promise((r) => setTimeout(r, 300));
            const filter = (node: HTMLElement) => {
              const c = node.classList;
              return (
                !c || (!c.contains("react-flow__controls") && !c.contains("react-flow__minimap"))
              );
            };
            if (kind === "png") {
              const blob = await toPng(el, { pixelRatio: 2, backgroundColor: bg, filter });
              await writeFile(path, new Uint8Array(await (await fetch(blob)).arrayBuffer()));
            } else {
              await writeTextFile(
                path,
                dataUrlToText(await toSvg(el, { backgroundColor: bg, filter })),
              );
            }
          }
          toast("已导出到 " + path, "success");
        } catch (e) {
          toast("导出失败：" + errText(e, "未知错误"), "error");
        }
      } finally {
        busyRef.current = false;
        setExporting(false);
      }
    },
    [canvasRef, toast],
  );

  return [exportAs, exporting];
}
