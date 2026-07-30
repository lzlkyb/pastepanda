import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { relativeTime } from "@/lib/utils";
import { getImageThumbnail } from "@/lib/api";

// ===== 数据类型 =====
interface PasteItem {
  id: string;
  type: string; // "text" | "image" | "file"
  text: string;
  content: string;
  pinned: boolean;
  time: string;
  source: string;
  content_type: string;
}

// ===== 类型标签 =====
function typeLabel(item: PasteItem): string {
  if (item.type === "image") return "🖼 图片";
  if (item.type === "file") return "📁 文件";
  const ct = item.content_type.toLowerCase();
  if (ct.includes("sql")) return "📋 SQL";
  if (ct.includes("code") || ct.includes("json") || ct.includes("xml")) return "{ } 代码";
  if (ct.includes("url") || ct.includes("link")) return "🔗 链接";
  if (ct.includes("email")) return "✉ 邮箱";
  if (ct.includes("phone")) return "📞 号码";
  return "📋 文本";
}

// ===== SVG 图标 =====
const IconClipboard = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.2" strokeLinecap="round" strokeLinejoin="round">
    <rect x="8" y="2" width="8" height="4" rx="1" />
    <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
  </svg>
);

const IconSearch = () => (
  <svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
    <circle cx="11" cy="11" r="7" />
    <path d="m21 21-4.3-4.3" />
  </svg>
);

const IconTrash = () => (
  <svg width="11" height="11" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6" />
  </svg>
);

const IconPin = ({ size = 11 }: { size?: number }) => (
  <svg width={size} height={size} viewBox="0 0 24 24" fill="currentColor">
    <path d="M16 3l5 5-5.5 1.5L13 12l-1 6-4-4-5 5 5-5-4-4 6-1 2.5-2.5L16 3z" />
  </svg>
);

export function QuickPastePanel() {
  const [items, setItems] = useState<PasteItem[]>([]);
  const [search, setSearch] = useState("");
  const [selIdx, setSelIdx] = useState(0);
  const [toast, setToast] = useState<{ msg: string; err?: boolean } | null>(null);
  const [thumbs, setThumbs] = useState<Record<string, string>>({});
  const searchRef = useRef<HTMLInputElement>(null);
  const toastTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const gridRef = useRef<HTMLDivElement>(null);

  const showToast = useCallback((msg: string, err = false) => {
    setToast({ msg, err });
    if (toastTimer.current) clearTimeout(toastTimer.current);
    toastTimer.current = setTimeout(() => setToast(null), 1800);
  }, []);

  // ===== 加载数据 =====
  const loadData = useCallback(async () => {
    try {
      const data = await invoke<PasteItem[]>("get_quick_paste_data");
      setItems(data);
      setSelIdx(0);
      setSearch("");
      // 预加载图片缩略图（getImageThumbnail 内部有 URL 缓存，重复调用无开销）
      const imgItems = data.filter((i) => i.type === "image" && i.content);
      for (const item of imgItems) {
        getImageThumbnail(item.content)
          .then((url) => setThumbs((prev) => (prev[item.content] === url ? prev : { ...prev, [item.content]: url })))
          .catch(() => { /* 缩略图加载失败静默 */ });
      }
      // 聚焦搜索框
      setTimeout(() => searchRef.current?.focus(), 50);
    } catch (e) {
      console.error("[QuickPaste] 加载数据失败", e);
    }
  }, []);

  useEffect(() => {
    loadData();
    let unlisten: UnlistenFn | null = null;
    listen("quick-paste-show", () => {
      loadData();
    }).then((u) => { unlisten = u; });
    return () => { unlisten?.(); };
  }, [loadData]);

  // ===== 过滤 =====
  const filtered = search.trim()
    ? items.filter((i) => {
        const kw = search.trim().toLowerCase();
        return i.text.toLowerCase().includes(kw) || i.source.toLowerCase().includes(kw);
      })
    : items;

  // ===== 粘贴 =====
  const doPaste = useCallback(async (item: PasteItem) => {
    // 先隐藏面板，再执行粘贴（粘贴引擎会恢复热键按下时的前台窗口）
    try {
      await invoke("hide_quick_paste");
    } catch { /* 忽略 */ }
    // 等待窗口隐藏完成，焦点回到目标
    await new Promise((r) => setTimeout(r, 150));
    try {
      if (item.type === "image" && item.content) {
        await invoke("paste_image", { imagePath: item.content });
      } else if (item.type === "file" && item.content) {
        await invoke("paste_text", { text: item.content });
      } else {
        await invoke("paste_text", { text: item.text });
      }
    } catch (e) {
      console.error("[QuickPaste] 粘贴失败", e);
    }
  }, []);

  // ===== 删除 =====
  const doDelete = useCallback(async (id: string) => {
    try {
      await invoke("delete_history", { ids: [id] });
      setItems((prev) => prev.filter((i) => i.id !== id));
      showToast("已删除");
    } catch (e) {
      console.error("[QuickPaste] 删除失败", e);
      showToast("删除失败", true);
    }
  }, [showToast]);

  // ===== 置顶切换 =====
  const doTogglePin = useCallback(async (id: string) => {
    try {
      const pinned = await invoke<boolean>("toggle_pin", { id });
      setItems((prev) => {
        const next = prev.map((i) => (i.id === id ? { ...i, pinned } : i));
        next.sort((a, b) => Number(b.pinned) - Number(a.pinned));
        return next;
      });
      showToast(pinned ? "已置顶" : "已取消置顶");
    } catch (e) {
      console.error("[QuickPaste] 置顶失败", e);
    }
  }, [showToast]);

  // ===== 清除全部（保留置顶） =====
  const doClearAll = useCallback(async () => {
    const ids = items.filter((i) => !i.pinned).map((i) => i.id);
    if (ids.length === 0) {
      showToast("没有可清除的记录");
      return;
    }
    try {
      await invoke("delete_history", { ids });
      setItems((prev) => prev.filter((i) => i.pinned));
      showToast(`已清除 ${ids.length} 条`);
    } catch (e) {
      console.error("[QuickPaste] 清除失败", e);
      showToast("清除失败", true);
    }
  }, [items, showToast]);

  // ===== 隐藏面板 =====
  const hidePanel = useCallback(() => {
    invoke("hide_quick_paste").catch(() => { /* 忽略 */ });
  }, []);

  // ===== 键盘导航 =====
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        hidePanel();
        return;
      }
      if (filtered.length === 0) return;
      if (e.key === "ArrowDown" || e.key === "ArrowRight") {
        e.preventDefault();
        setSelIdx((prev) => Math.min(prev + 1, filtered.length - 1));
      } else if (e.key === "ArrowUp" || e.key === "ArrowLeft") {
        e.preventDefault();
        setSelIdx((prev) => Math.max(prev - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        const item = filtered[selIdx];
        if (item) doPaste(item);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [filtered, selIdx, doPaste, hidePanel]);

  // 选中项滚动到可视区
  useEffect(() => {
    const grid = gridRef.current;
    if (!grid) return;
    const el = grid.children[selIdx] as HTMLElement | undefined;
    el?.scrollIntoView({ block: "nearest" });
  }, [selIdx]);

  return (
    <div className="qp-panel">
      {/* 头部 */}
      <div className="qp-head">
        <span className="qp-title">
          <IconClipboard />
          剪贴板历史
        </span>
        <button className="qp-clear" onClick={doClearAll} title="清除全部（保留置顶）">
          <IconTrash />
          清除
        </button>
      </div>

      {/* 搜索 */}
      <div className="qp-search">
        <IconSearch />
        <input
          ref={searchRef}
          placeholder="搜索…"
          value={search}
          onChange={(e) => { setSearch(e.target.value); setSelIdx(0); }}
        />
      </div>

      {/* 网格 */}
      {filtered.length === 0 ? (
        <div className="qp-empty">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="8" y="2" width="8" height="4" rx="1" />
            <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
          </svg>
          {search ? "没有匹配的记录" : "剪贴板暂无记录"}
        </div>
      ) : (
        <div className="qp-grid" ref={gridRef}>
          {filtered.map((item, idx) => (
            <div
              key={item.id}
              className={`qp-item${item.pinned ? " pinned" : ""}${idx === selIdx ? " sel" : ""}`}
              onClick={() => doPaste(item)}
              onMouseEnter={() => setSelIdx(idx)}
            >
              {/* 删除按钮 */}
              <button
                className="qp-del"
                onClick={(e) => { e.stopPropagation(); doDelete(item.id); }}
                title="删除"
              >✕</button>
              {/* 置顶标记 / 置顶按钮 */}
              {item.pinned ? (
                <span className="qp-pin" title="已置顶"><IconPin /></span>
              ) : (
                <button
                  className="qp-pinbtn"
                  onClick={(e) => { e.stopPropagation(); doTogglePin(item.id); }}
                  title="置顶"
                ><IconPin /></button>
              )}

              {/* 预览区 */}
              {item.type === "image" ? (
                <div className="qp-prev img">
                  {thumbs[item.content] ? (
                    <img src={thumbs[item.content]} alt="" draggable={false} />
                  ) : (
                    <span style={{ margin: "auto", fontSize: 16 }}>🖼</span>
                  )}
                </div>
              ) : (
                <div className="qp-prev">
                  {item.type === "file" ? `📄 ${item.text}` : item.text}
                </div>
              )}

              {/* 底栏 */}
              <div className="qp-foot">
                <span className="qp-type">{typeLabel(item)}</span>
                <span className="qp-time">{relativeTime(item.time)}</span>
              </div>
            </div>
          ))}
        </div>
      )}

      {/* 状态栏 */}
      <div className="qp-statusbar">
        <span>{filtered.length} 条记录</span>
        <span className="qp-keys">
          <span><kbd>↑↓</kbd> 选择</span>
          <span><kbd>Enter</kbd> 粘贴</span>
          <span><kbd>Esc</kbd> 关闭</span>
        </span>
      </div>

      {/* Toast */}
      <div className={`qp-toast${toast ? " show" : ""}`}>
        <span className={`dot${toast?.err ? " err" : ""}`} />
        {toast?.msg}
      </div>
    </div>
  );
}
