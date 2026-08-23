import { useState, useEffect, useRef, useCallback } from "react";
import { X, Copy, Download, Image as ImageIcon, ClipboardPaste } from "lucide-react";
import { ActionBtn } from "./editorBits";
import { useToast } from "@/components/Toast";
import { errText } from "@/lib/utils";

/**
 * 二维码双向编辑器（Tier2 · 复用 QRCodeDialog 的 qrcode 生成 + ScreenshotOverlay 的 jsqr 解码）：
 * 独立工具弹窗（从变换枢纽入口打开，不走 editorRegistry）。
 * 两个模式：
 *  - 生成：文本/URL → QR（qrcode.toCanvas，全程本地）
 *  - 识图：选图/拖拽/粘贴图片 → jsQR 解码出文本（全程本地，不上云）
 */
const MAX_QR_BYTES = 2000;
const MAX_DEC_SIDE = 1600;

function extToMime(p: string): string {
  const ext = p.split(".").pop()?.toLowerCase() ?? "";
  return {
    png: "image/png", jpg: "image/jpeg", jpeg: "image/jpeg",
    webp: "image/webp", bmp: "image/bmp", gif: "image/gif",
  }[ext] ?? "image/png";
}

/** 把位图缩放后交给 jsQR 解码 */
async function decodeBitmap(bmp: ImageBitmap): Promise<string | null> {
  const scale = Math.min(1, MAX_DEC_SIDE / Math.max(bmp.width, bmp.height));
  const w = Math.max(1, Math.round(bmp.width * scale));
  const h = Math.max(1, Math.round(bmp.height * scale));
  const canvas = document.createElement("canvas");
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(bmp, 0, 0, w, h);
  const imgData = ctx.getImageData(0, 0, w, h);
  const jsQR = (await import("jsqr")).default;
  const qr = jsQR(imgData.data, imgData.width, imgData.height, { inversionAttempts: "attemptBoth" });
  return qr?.data ?? null;
}

export function QREditor({ initialText, onClose }: { initialText: string; onClose: () => void }) {
  const [mode, setMode] = useState<"encode" | "decode">("encode");
  const [text, setText] = useState(initialText);
  const [ready, setReady] = useState(false);
  const [genError, setGenError] = useState(false);
  const [retryKey, setRetryKey] = useState(0);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const { toast } = useToast();

  // 识图状态
  const [decoding, setDecoding] = useState(false);
  const [decoded, setDecoded] = useState("");
  const [decodeError, setDecodeError] = useState("");

  const isUrl = /^https?:\/\//i.test(text.trim());
  const textBytes = new TextEncoder().encode(text).length;
  const tooLong = textBytes > MAX_QR_BYTES;

  // 生成二维码（镜像 QRCodeDialog）
  useEffect(() => {
    if (mode !== "encode") return;
    let cancelled = false;
    setReady(false);
    setGenError(false);
    import("qrcode").then((QRCode) => {
      if (cancelled || !canvasRef.current) return;
      QRCode.toCanvas(canvasRef.current, text, {
        width: 240, margin: 2,
        color: { dark: "#0F172A", light: "#FFFFFF" },
        errorCorrectionLevel: "M",
      }, (err) => {
        if (cancelled) return;
        if (err) { setGenError(true); return; }
        setReady(true);
      });
    }).catch(() => { if (!cancelled) setGenError(true); });
    return () => { cancelled = true; };
  }, [text, retryKey, mode]);

  // Esc 关闭
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === "Escape") { e.preventDefault(); onClose(); } };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // ===== 生成：复制图片 / 保存 PNG =====
  const copyImage = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas || !ready) return;
    try {
      const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));
      if (!blob) { toast("复制失败", "error"); return; }
      await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]);
      toast("已复制二维码图片", "success");
    } catch (e) { toast("复制失败：" + errText(e, "未知错误"), "error"); }
  }, [ready, toast]);

  const savePng = useCallback(async () => {
    const canvas = canvasRef.current;
    if (!canvas || !ready) return;
    try {
      const { save } = await import("@tauri-apps/plugin-dialog");
      const { writeFile } = await import("@tauri-apps/plugin-fs");
      const path = await save({ defaultPath: "qrcode.png", filters: [{ name: "PNG 图片", extensions: ["png"] }] });
      if (!path) return;
      const dataUrl = canvas.toDataURL("image/png");
      const base64 = dataUrl.split(",")[1];
      const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
      await writeFile(path, bytes);
      toast("已保存 PNG", "success");
    } catch (e) { toast("保存失败：" + errText(e, "未知错误"), "error"); }
  }, [ready, toast]);

  const copyText = useCallback(async () => {
    try { await navigator.clipboard.writeText(text); toast("已复制文本", "success"); }
    catch { toast("复制失败", "error"); }
  }, [text, toast]);

  // ===== 识图：选图 / 拖拽 / 粘贴 =====
  const runDecode = useCallback(async (bmp: ImageBitmap) => {
    setDecoding(true);
    setDecodeError("");
    try {
      const res = await decodeBitmap(bmp);
      setDecoded(res ?? "");
      if (!res) setDecodeError("未识别到二维码，请换一张更清晰的图");
    } catch (e) {
      setDecodeError(errText(e, "解码失败"));
    } finally {
      setDecoding(false);
    }
  }, []);

  const pickImage = useCallback(async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const path = await open({ multiple: false, filters: [{ name: "图片", extensions: ["png", "jpg", "jpeg", "webp", "bmp", "gif"] }] });
      if (!path || typeof path !== "string") return;
      const { readFile } = await import("@tauri-apps/plugin-fs");
      const bytes = await readFile(path);
      const blob = new Blob([bytes as BlobPart], { type: extToMime(path) });
      const bmp = await createImageBitmap(blob);
      await runDecode(bmp);
    } catch (e) { toast("读取图片失败：" + errText(e, "未知错误"), "error"); }
  }, [runDecode, toast]);

  const onPaste = useCallback(async (e: React.ClipboardEvent) => {
    const item = Array.from(e.clipboardData.items).find((i) => i.type.startsWith("image/"));
    if (!item) return;
    const file = item.getAsFile();
    if (!file) return;
    e.preventDefault();
    const bmp = await createImageBitmap(file);
    await runDecode(bmp);
  }, [runDecode]);

  const onDrop = useCallback(async (e: React.DragEvent) => {
    e.preventDefault();
    const file = Array.from(e.dataTransfer.files).find((f) => f.type.startsWith("image/"));
    if (!file) return;
    const bmp = await createImageBitmap(file);
    await runDecode(bmp);
  }, [runDecode]);

  const copyDecoded = useCallback(async () => {
    if (!decoded) return;
    try { await navigator.clipboard.writeText(decoded); toast("已复制内容", "success"); }
    catch { toast("复制失败", "error"); }
  }, [decoded, toast]);

  return (
    <div className="dialog-backdrop" onClick={onClose}>
      <div
        className="dialog-box dialog-solid w420"
        onClick={(e) => e.stopPropagation()}
        style={{ maxHeight: "86vh" }}
      >
        <div className="dialog-header">
          <h2 className="dialog-title">📱 二维码工作台</h2>
          <button className="dialog-close" onClick={onClose}><X size={16} /></button>
        </div>

        <div className="code-meta-bar">
          <span className="spacer" />
          <div className="md-mode-toggle">
            <button className={mode === "encode" ? "active" : ""} onClick={() => setMode("encode")}>生成</button>
            <button className={mode === "decode" ? "active" : ""} onClick={() => setMode("decode")}>识图</button>
          </div>
        </div>

        <div className="dialog-body" style={{ gap: 12, alignItems: "stretch" }}>
          {mode === "encode" ? (
            <>
              <textarea
                style={{
                  width: "100%", minHeight: 90, margin: 0, padding: "10px 12px", borderRadius: 10,
                  border: "1px solid var(--border-color)", background: "var(--card-bg)",
                  fontFamily: "'SF Mono', Consolas, monospace", fontSize: 13, lineHeight: 1.6,
                  color: "var(--text-primary)", resize: "vertical", whiteSpace: "pre-wrap", wordBreak: "break-all",
                }}
                value={text}
                spellCheck={false}
                placeholder="输入要生成二维码的文本或链接…"
                onChange={(e) => setText(e.target.value)}
              />
              <div className="qr-canvas-wrap">
                <canvas ref={canvasRef} className="qr-canvas" style={{ opacity: ready ? 1 : 0 }} />
                {!ready && !genError && <div className="qr-loading">生成中…</div>}
                {genError && (
                  <div className="qr-error">
                    <div className="qr-error-msg">{tooLong ? `文本过长（${textBytes} 字节），超出二维码容量` : "生成失败"}</div>
                    {!tooLong && <button className="qr-retry-btn" onClick={() => setRetryKey((k) => k + 1)}>重试</button>}
                  </div>
                )}
              </div>
              <span className="qr-badge">{isUrl ? "🔗 URL" : "📝 文本"}</span>
              <div className="note">二维码全程本地生成（qrcode 库），不上云。</div>
            </>
          ) : (
            <>
              <div
                className="qr-drop"
                onClick={pickImage}
                onDrop={onDrop}
                onDragOver={(e) => e.preventDefault()}
                onPaste={onPaste}
                tabIndex={0}
              >
                <ImageIcon size={20} style={{ marginBottom: 6 }} />
                <div>点击选择图片 / 拖拽到此处 / 直接粘贴（Ctrl+V）</div>
                <div style={{ fontSize: 10, opacity: 0.8 }}>支持 PNG · JPG · WEBP · BMP</div>
              </div>
              <textarea
                className="qr-result"
                value={decoded}
                readOnly
                spellCheck={false}
                placeholder="识别出的内容将显示在这里…"
              />
              {decoding && <div className="note">识别中…</div>}
              {decodeError && <div className="qr-decode-err">{decodeError}</div>}
              <div className="note">识图全程本地（jsqr），不解码外传。</div>
            </>
          )}
        </div>

        <div className="dialog-footer">
          <span>{mode === "encode" ? "实时生成 · Esc 关闭" : "本地识图 · Esc 关闭"}</span>
          <div className="right">
            {mode === "encode" ? (
              <>
                <ActionBtn icon={<Copy size={13} />} label="复制文本" onClick={copyText} />
                <ActionBtn icon={<Copy size={13} />} label="复制图片" onClick={copyImage} disabled={!ready} />
                <ActionBtn icon={<Download size={13} />} label="保存 PNG" onClick={savePng} disabled={!ready} />
              </>
            ) : (
              <ActionBtn icon={<ClipboardPaste size={13} />} label="复制内容" onClick={copyDecoded} disabled={!decoded} />
            )}
            <ActionBtn icon={<X size={13} />} label="关闭" onClick={onClose} />
          </div>
        </div>
      </div>
    </div>
  );
}
