import { useEffect, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { logger } from "@/lib/logger";

/** 贴图管理面板（V6.19）：托盘"贴图管理"→ 主窗口弹层。
 *  列表显示当前所有置顶贴图，支持复制 / 重新编辑 / 关闭单张 / 关闭全部。 */
export default function PinnedPanel({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [paths, setPaths] = useState<string[]>([]);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    let cancelled = false;
    void (async () => {
      try {
        const list = await invoke<string[]>("list_pinned_images");
        if (cancelled) return;
        setPaths(list);
        const t: Record<string, string> = {};
        for (const p of list) {
          try {
            const url = await invoke<string>("get_image_data_url", { path: p });
            t[p] = url;
          } catch {
            /* 单张读取失败跳过 */
          }
        }
        if (!cancelled) setThumbs(t);
      } catch (e) {
        logger.warn("贴图列表加载失败", e);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open]);

  if (!open) return null;

  const copyOne = async (path: string) => {
    try {
      await invoke("copy_image_only", { imagePath: path });
      setCopied(path);
      setTimeout(() => setCopied(null), 1200);
    } catch (e) {
      logger.warn("复制贴图失败", e);
    }
  };

  const editOne = (path: string) => {
    void invoke("open_pinned_edit", { path }).catch((e) => logger.warn("重编辑失败", e));
    onClose();
  };

  const closeOne = (path: string) => {
    void invoke("close_pinned_image_by_path", { path });
    setPaths((prev) => prev.filter((p) => p !== path));
  };

  const closeAll = () => {
    void invoke("close_pinned_image");
    setPaths([]);
  };

  return (
    <div
      style={{
        position: "fixed", inset: 0, zIndex: 9999,
        display: "flex", alignItems: "center", justifyContent: "center",
        background: "rgba(8, 12, 24, 0.55)", backdropFilter: "blur(4px)",
      }}
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) onClose();
      }}
    >
      <div
        style={{
          width: 480, maxHeight: 560, display: "flex", flexDirection: "column",
          background: "linear-gradient(180deg, #1B2340, #101528)",
          border: "1px solid rgba(99, 102, 241, 0.35)", borderRadius: 14,
          boxShadow: "0 24px 64px rgba(0,0,0,0.5)", overflow: "hidden",
        }}
      >
        <div style={{ display: "flex", alignItems: "center", padding: "12px 16px", borderBottom: "1px solid rgba(125,140,255,0.18)" }}>
          <span style={{ fontSize: 14, fontWeight: 600, color: "#E6EDF7" }}>📌 贴图管理</span>
          <span style={{ flex: 1 }} />
          <span style={{ fontSize: 11, color: "#8FA3C8", marginRight: 10 }}>
            {paths.length > 0 ? `${paths.length} 张贴图置顶中` : "当前无贴图"}
          </span>
          <button
            onClick={onClose}
            style={{ border: "none", background: "transparent", color: "#8FA3C8", cursor: "pointer", fontSize: 15 }}
          >
            ✕
          </button>
        </div>
        <div style={{ flex: 1, overflow: "auto", padding: 10, display: "flex", flexDirection: "column", gap: 8 }}>
          {paths.length === 0 && (
            <div style={{ textAlign: "center", padding: 40, color: "#6B7FA3", fontSize: 12 }}>
              暂无置顶贴图 · 截图后点「贴图置顶」即可钉在屏幕上
            </div>
          )}
          {paths.map((p) => (
            <div
              key={p}
              style={{
                display: "flex", alignItems: "center", gap: 12, padding: 8,
                background: "rgba(20, 26, 50, 0.7)", borderRadius: 10,
                border: "1px solid rgba(99, 102, 241, 0.15)",
              }}
            >
              <div
                style={{
                  width: 64, height: 44, borderRadius: 6, overflow: "hidden", flexShrink: 0,
                  background: "#16233F", display: "flex", alignItems: "center", justifyContent: "center",
                }}
              >
                {thumbs[p] ? (
                  <img src={thumbs[p]} alt="" style={{ maxWidth: "100%", maxHeight: "100%", objectFit: "contain" }} />
                ) : (
                  <span style={{ fontSize: 10, color: "#5B6F96" }}>…</span>
                )}
              </div>
              <span style={{ flex: 1, fontSize: 11, color: "#9DB2D0", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }} title={p}>
                {p.split(/[\\/]/).pop()}
              </span>
              <button onClick={() => void copyOne(p)} style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid rgba(99,102,241,0.4)", background: "transparent", color: "#B9C6F0", fontSize: 10, cursor: "pointer" }}>
                {copied === p ? "已复制 ✓" : "复制"}
              </button>
              <button onClick={() => editOne(p)} style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid rgba(99,102,241,0.4)", background: "transparent", color: "#B9C6F0", fontSize: 10, cursor: "pointer" }}>
                编辑
              </button>
              <button onClick={() => closeOne(p)} style={{ padding: "4px 10px", borderRadius: 6, border: "1px solid rgba(248,113,113,0.4)", background: "transparent", color: "#FCA5A5", fontSize: 10, cursor: "pointer" }}>
                关闭
              </button>
            </div>
          ))}
        </div>
        {paths.length > 0 && (
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "10px 16px", borderTop: "1px solid rgba(125,140,255,0.18)" }}>
            <button
              onClick={closeAll}
              style={{ padding: "6px 14px", borderRadius: 8, border: "1px solid rgba(248,113,113,0.45)", background: "transparent", color: "#FCA5A5", fontSize: 11, cursor: "pointer" }}
            >
              关闭全部贴图
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
