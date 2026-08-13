/**
 * 导出流程图（PNG / SVG / Mermaid / .panda）。
 *
 * 内嵌编辑器与全屏编辑器原本各存了一份逐字相同的 exportAs 与 dataUrlToText，
 * 这里收口成一份（规则 #11：公共逻辑单一数据源）。
 */
import { useCallback, type RefObject } from "react";
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

export function useDiagramExport(canvasRef: RefObject<ExportSource | null>) {
  const { toast } = useToast();

  return useCallback(
    async (kind: ExportKind) => {
      const doc = canvasRef.current?.getDoc();
      if (!doc) return;
      const path = await saveDialog({ defaultPath: `流程图.${EXT[kind]}`, filters: FILTERS[kind] });
      if (!path) return;
      try {
        if (kind === "mermaid") {
          await writeTextFile(path, toMermaid(doc));
        } else if (kind === "panda") {
          await writeTextFile(path, serializeDiagram(doc));
        } else {
          const el = document.querySelector<HTMLElement>(".react-flow");
          if (!el) throw new Error("画布未就绪");
          const bg = getComputedStyle(el).getPropertyValue("--diagram-canvas-bg").trim() || "#0b1220";
          // 先整图适配视口，避免只截到可视区；再剔除控件/缩略图后截图
          canvasRef.current?.fitView();
          await new Promise((r) => setTimeout(r, 300));
          const filter = (node: HTMLElement) => {
            const c = node.classList;
            return !c || (!c.contains("react-flow__controls") && !c.contains("react-flow__minimap"));
          };
          if (kind === "png") {
            const blob = await toPng(el, { pixelRatio: 2, backgroundColor: bg, filter });
            await writeFile(path, new Uint8Array(await (await fetch(blob)).arrayBuffer()));
          } else {
            await writeTextFile(path, dataUrlToText(await toSvg(el, { backgroundColor: bg, filter })));
          }
        }
        toast("已导出到 " + path, "success");
      } catch (e) {
        toast("导出失败：" + errText(e, "未知错误"), "error");
      }
    },
    [canvasRef, toast],
  );
}
