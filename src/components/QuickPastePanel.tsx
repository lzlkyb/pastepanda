import { useState, useEffect, useCallback, useRef } from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { relativeTime } from "@/lib/utils";
import { getImageThumbnail } from "@/lib/api";
import { logger } from "@/lib/logger";
import { SkinScene } from "./SkinScene";

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

// ===== 类型图标（仅符号，用于列表布局的类型徽标）=====
function typeIcon(item: PasteItem): string {
  if (item.type === "image") return "🖼";
  if (item.type === "file") return "📁";
  const ct = item.content_type.toLowerCase();
  if (ct.includes("sql")) return "📋";
  if (ct.includes("code") || ct.includes("json") || ct.includes("xml")) return "{ }";
  if (ct.includes("url") || ct.includes("link")) return "🔗";
  if (ct.includes("email")) return "✉";
  if (ct.includes("phone")) return "📞";
  return "📋";
}

// ===== 类型名称（纯文字，用于列表布局的副标题）=====
function typeName(item: PasteItem): string {
  if (item.type === "image") return "图片";
  if (item.type === "file") return "文件";
  const ct = item.content_type.toLowerCase();
  if (ct.includes("sql")) return "SQL";
  if (ct.includes("code") || ct.includes("json") || ct.includes("xml")) return "代码";
  if (ct.includes("url") || ct.includes("link")) return "链接";
  if (ct.includes("email")) return "邮箱";
  if (ct.includes("phone")) return "号码";
  return "文本";
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
  const [layout, setLayout] = useState<"grid" | "list">("grid");
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
      // 每次显示都重读布局配置：设置中切换布局后，下次唤出即生效
      // （窗口尺寸由 Rust 侧同步调整，这里只负责渲染形态）
      try {
        const cfg = await invoke<{ quick_paste_layout?: string }>("get_config");
        setLayout(cfg.quick_paste_layout === "list" ? "list" : "grid");
      } catch { /* 读取失败保持当前布局 */ }
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
      // 统一走项目 logger（写持久日志）而不是 console：本面板是热键唤出的独立窗口，
      // 出问题时用户不会去开 devtools，console 里的错误等于没记录
      logger.error("[QuickPaste] 加载数据失败", e);
    }
  }, []);

  useEffect(() => {
    loadData();
    // 修复监听器泄漏：原写法把 unlisten 放在 .then() 里赋值，而 cleanup 是同步执行的，
    // 若 cleanup 先跑（React StrictMode 在 dev 下会 mount→unmount→remount），unlisten 还是 null，
    // 监听器永远解不掉 → 之后每次唤出面板 loadData() 跑两遍（重复拉数据 + 重复加缩略图）。
    // 同一模式在 App.tsx 与 TrayPopup.tsx 已分别修过，这是第三处。
    let cancelled = false;
    let unlisten: UnlistenFn | null = null;
    listen("quick-paste-show", () => {
      loadData();
    }).then((u) => {
      // 拿到 unlisten 时若已卸载，立即自我解绑
      if (cancelled) { u(); return; }
      unlisten = u;
    });
    return () => {
      cancelled = true;
      unlisten?.();
    };
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
    // 不要提前隐藏面板：粘贴引擎会用热键按下时保存的目标窗口执行
    // SetForegroundWindow，面板失焦后自动隐藏（Focused(false) 监听）。
    // 若先隐藏，前台归属出现竞态，反而可能丢失粘贴目标。
    try {
      if (item.type === "image" && item.content) {
        await invoke("paste_image", { imagePath: item.content });
      } else if (item.type === "rich" && item.content) {
        await invoke("paste_rich", { htmlFragment: item.content, plainText: item.text });
      } else if (item.type === "file" && item.content) {
        await invoke("paste_text", { text: item.content });
      } else {
        await invoke("paste_text", { text: item.text });
      }
      // 成功后兜底隐藏（正常情况下失焦已自动隐藏）
      invoke("hide_quick_paste").catch(() => { /* 忽略 */ });
    } catch (e) {
      // 注意：粘贴引擎会 SetForegroundWindow 到目标窗口，而本面板失焦即自动隐藏
      // （quick_paste.rs 的 WindowEvent::Focused(false)）。若失败发生在夺焦之后，
      // 下面这个 toast 会渲染在一个正在消失的窗口上、用户看不到，
      // 所以必须同时写持久日志，否则这类失败会完全无迹可查
      logger.error("[QuickPaste] 粘贴失败", e);
      showToast("粘贴失败", true);
    }
  }, [showToast]);

  // ===== 删除 =====
  const doDelete = useCallback(async (id: string) => {
    try {
      await invoke("delete_history", { ids: [id] });
      setItems((prev) => prev.filter((i) => i.id !== id));
      showToast("已删除");
    } catch (e) {
      logger.error("[QuickPaste] 删除失败", e);
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
      logger.error("[QuickPaste] 置顶失败", e);
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
      logger.error("[QuickPaste] 清除失败", e);
      showToast("清除失败", true);
    }
  }, [items, showToast]);

  // ===== 清除全部：两步确认 =====
  // 为什么需要确认：面板是热键唤出的、按钮就在标题栏右上角紧靠搜索框，误点代价是
  // 抹掉全部非置顶历史，而这里的删除**无法撤销**：undoStack 是前端 store 状态，
  // 本窗口与主窗口是两个独立的 React 实例/store，就算写也不是同一个栈。
  // （后端虽有 clear_history_with_undo，但它是“按天数清理”语义，与这里按 ids 删不匹配）
  // 为何用两步确认而不是模态框：面板失焦即自动隐藏，且 Escape 已绑定为关闭面板，
  // 弹模态框会与这两个行为打架；两步确认失焦时自然重置（fail closed）。
  const [clearConfirm, setClearConfirm] = useState(false);
  const clearTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const clearableCount = items.filter((i) => !i.pinned).length;

  const requestClearAll = useCallback(() => {
    if (clearableCount === 0) { showToast("没有可清除的记录"); return; }
    if (!clearConfirm) {
      setClearConfirm(true);
      if (clearTimer.current) clearTimeout(clearTimer.current);
      clearTimer.current = setTimeout(() => setClearConfirm(false), 4000);
      return;
    }
    if (clearTimer.current) clearTimeout(clearTimer.current);
    setClearConfirm(false);
    void doClearAll();
  }, [clearConfirm, clearableCount, doClearAll, showToast]);

  // 卸载时清定时器，避免对已卸载组件 setState
  useEffect(() => () => {
    if (clearTimer.current) clearTimeout(clearTimer.current);
    if (toastTimer.current) clearTimeout(toastTimer.current);
  }, []);

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
    <>
      <SkinScene />
      <div className="qp-panel">
      {/* 头部 */}
      <div className="qp-head">
        <span className="qp-title">
          <IconClipboard />
          剪贴板历史
        </span>
        <button
          className={`qp-clear${clearConfirm ? " confirm" : ""}`}
          onClick={requestClearAll}
          title={clearConfirm ? "再点一次确认清除（不可撤销）" : "清除全部（保留置顶）"}
        >
          <IconTrash />
          {clearConfirm ? `确认清除 ${clearableCount} 条？` : "清除"}
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

      {/* 内容区：按布局渲染 单栏列表（B）或 双栏网格（C） */}
      {filtered.length === 0 ? (
        <div className="qp-empty">
          <svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.5">
            <rect x="8" y="2" width="8" height="4" rx="1" />
            <path d="M16 4h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H6a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2h2" />
          </svg>
          {search ? "没有匹配的记录" : "剪贴板暂无记录"}
        </div>
      ) : layout === "list" ? (
        <div className="qp-list" ref={gridRef}>
          {filtered.map((item, idx) => (
            <div
              key={item.id}
              className={`qp-row${item.pinned ? " pinned" : ""}${idx === selIdx ? " sel" : ""}`}
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

              {/* 类型徽标 */}
              {item.type === "image" ? (
                <span className="qp-ico img">
                  {thumbs[item.content] ? (
                    <img src={thumbs[item.content]} alt="" draggable={false} />
                  ) : (
                    "🖼"
                  )}
                </span>
              ) : (
                <span className="qp-ico">{typeIcon(item)}</span>
              )}

              {/* 文本主体 */}
              <div className="qp-body">
                <div className="qp-maintxt">{item.text}</div>
                <div className="qp-sub">
                  <span>{typeName(item)}</span>
                  <span>·</span>
                  <span>{relativeTime(item.time)}</span>
                </div>
              </div>
            </div>
          ))}
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
    </>
  );
}
