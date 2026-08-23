import { useEffect, useRef, useState } from "react";
import { Loader, Copy, ZoomIn, ZoomOut, ChevronLeft, ChevronRight } from "lucide-react";
import { useToast } from "@/components/Toast";
import type { PDFDocumentProxy, PDFDocumentLoadingTask } from "pdfjs-dist";

/**
 * PdfViewer（Tier2，方案 B）— file 类型 .pdf 分支的内嵌阅读预览。
 * pdfjs-dist 动态 import（不进主包，仅打开 PDF 时加载）；worker 用 vite `?worker` 独立 chunk。
 * 功能：翻页（◀ ▶ + 页码）、缩放（− / +，0.5~3）、复制本页文本（getTextContent）。
 * 出错时显示错误提示；外壳另有「用系统打开」降级。
 */
export function PdfViewer({ path }: { path: string }) {
  const { toast } = useToast();
  const [doc, setDoc] = useState<PDFDocumentProxy | null>(null);
  const [numPages, setNumPages] = useState(0);
  const [pageNum, setPageNum] = useState(1);
  const [scale, setScale] = useState(1.2);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [copying, setCopying] = useState(false);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const renderTaskRef = useRef<{ cancel: () => void } | null>(null);

  // 加载文档：动态 import pdfjs + worker + plugin-fs readFile
  useEffect(() => {
    let cancelled = false;
    let loadingTask: PDFDocumentLoadingTask | null = null;
    (async () => {
      setLoading(true);
      setError("");
      try {
        const pdfjs = await import("pdfjs-dist");
        const workerMod = await import("pdfjs-dist/build/pdf.worker.min.mjs?worker");
        pdfjs.GlobalWorkerOptions.workerPort = new workerMod.default();
        // 走 Rust 命令读，不用 plugin-fs：`fs:default` 只授予**应用自身目录**的读权限，
        // 而这里的 path 是用户复制进来的原始路径（任意位置），plugin-fs 会直接拒。
        // 要让前端读就得把 fs:scope 开成 `**`，等于把整个文件系统交给 WebView。
        // Rust 侧 read_pdf_as_base64 保留白名单（仅 .pdf）+ canonicalize + 50MB 上限。
        const { invoke } = await import("@tauri-apps/api/core");
        const b64 = await invoke<string>("read_pdf_as_base64", { path });
        // 用 fetch(dataUrl) 让浏览器网络栈解码 base64，替代 atob + 逐字节 charCodeAt 循环：
        // 后者会在主线程上同时握着 base64 串、atob 出的二进制串、Uint8Array 三份副本
        // （50MB 的 PDF 瞬时占用 160MB+）。同 api/images.ts 里 dataUrlToBlob 的理由。
        const buf = await (await fetch(`data:application/pdf;base64,${b64}`)).arrayBuffer();
        const data = new Uint8Array(buf);
        // 注：pdfjs v6 已移除 isEvalSupported 选项（上游不再用 eval 优化字体），
        // 所以不需要在这里额外关它。
        loadingTask = pdfjs.getDocument({ data });
        const pdf = await loadingTask.promise;
        if (cancelled) { loadingTask.destroy(); return; }
        setDoc(pdf);
        setNumPages(pdf.numPages);
        setPageNum(1);
        setScale(1.2);
      } catch (e) {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
      if (loadingTask) loadingTask.destroy();
    };
  }, [path]);

  // 渲染当前页（×devicePixelRatio 保证高清；翻页/缩放竞态由 renderTask.cancel 兜底）
  useEffect(() => {
    if (!doc) return;
    let cancelled = false;
    (async () => {
      try {
        const page = await doc.getPage(pageNum);
        if (cancelled) return;
        const canvas = canvasRef.current;
        if (!canvas) return;
        const viewport = page.getViewport({ scale });
        const dpr = window.devicePixelRatio || 1;
        canvas.width = Math.floor(viewport.width * dpr);
        canvas.height = Math.floor(viewport.height * dpr);
        // ❗ 位图放大了 dpr 倍，绘制也必须同倍放大：pdf.js 不会自己套 devicePixelRatio
        // （官方 viewer 走的就是这个 transform）。少了它，Windows 125%/150% 缩放下
        // 页面只画在画布左上角 1/dpr 的区域里，其余是空白。
        // 同时把 CSS 宽度钉成逻辑像素（高度留给样式表的 height:auto 按内在比例推导，
        // 这样 .pdf-canvas 的 max-width:100% 缩小时也不会拉变形）。
        canvas.style.width = `${Math.floor(viewport.width)}px`;
        const task = page.render({
          canvas,
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined,
        });
        renderTaskRef.current = task;
        await task.promise;
      } catch {
        /* 翻页竞态 / 组件销毁：静默 */
      }
    })();
    return () => {
      cancelled = true;
      renderTaskRef.current?.cancel();
      renderTaskRef.current = null;
    };
  }, [doc, pageNum, scale]);

  const copyPageText = async () => {
    if (!doc || copying) return;
    setCopying(true);
    try {
      const page = await doc.getPage(pageNum);
      const tc = await page.getTextContent();
      const text = tc.items.map((it) => ("str" in it ? it.str : "")).join("\n");
      await navigator.clipboard.writeText(text);
      toast(`已复制第 ${pageNum} 页文本`, "success");
    } catch {
      toast("复制失败", "error");
    } finally {
      setCopying(false);
    }
  };

  return (
    <div className="pdf-wrap">
      <div className="pdf-toolbar">
        <button
          className="fpt-btn"
          disabled={!doc || pageNum <= 1}
          onClick={() => setPageNum((p) => Math.max(1, p - 1))}
          title="上一页"
        >
          <ChevronLeft size={13} /> 上一页
        </button>
        <span className="pdf-page-info">{doc ? `${pageNum} / ${numPages}` : "—"}</span>
        <button
          className="fpt-btn"
          disabled={!doc || pageNum >= numPages}
          onClick={() => setPageNum((p) => Math.min(numPages, p + 1))}
          title="下一页"
        >
          下一页 <ChevronRight size={13} />
        </button>
        <span className="pdf-sep" />
        <button className="fpt-btn" disabled={!doc} onClick={() => setScale((s) => Math.max(0.5, Math.round((s - 0.2) * 100) / 100))} title="缩小">
          <ZoomOut size={13} />
        </button>
        <span className="pdf-scale-info">{Math.round(scale * 100)}%</span>
        <button className="fpt-btn" disabled={!doc} onClick={() => setScale((s) => Math.min(3, Math.round((s + 0.2) * 100) / 100))} title="放大">
          <ZoomIn size={13} />
        </button>
        <span className="pdf-sep" />
        <button className="fpt-btn" disabled={!doc || copying} onClick={copyPageText} title="提取本页文本并复制">
          <Copy size={13} /> {copying ? "提取中…" : "复制本页文本"}
        </button>
      </div>

      <div className="pdf-canvas-wrap">
        {loading && (
          <div className="file-preview-loading">
            <Loader size={13} className="spin" /> 加载 PDF…
          </div>
        )}
        {!loading && error && (
          <div className="file-preview-empty fd-empty">
            <span style={{ color: "var(--danger, #EF4444)" }}>⚠ 无法解析 PDF</span>
            <span style={{ fontSize: 11, color: "var(--text-muted)", wordBreak: "break-all", maxWidth: 320 }}>{error}</span>
          </div>
        )}
        {!loading && !error && <canvas ref={canvasRef} className="pdf-canvas" />}
      </div>
    </div>
  );
}
