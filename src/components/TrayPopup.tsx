import { useState, useEffect, useCallback, useRef } from "react";
import { ThemeKey, DEFAULT_THEME } from "@/lib/theme";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { pasteTextGuarded, pasteImage, pasteRichGuarded } from "@/lib/api";
import { VersionBadge } from "@/components/VersionBadge";
import { AppIcon } from "@/components/AppIcon";
import { SkinScene } from "@/components/SkinScene";
import { TrayPopupSuggestion } from "@/components/TrayPopupSuggestion";
import { useAppStore } from "@/stores/appStore";

// ===== 数据类型 =====
interface RecentItem {
  id: string;
  type: string; // "text" | "image" | "file" | "rich"
  preview: string;
  text: string;
  content?: string; // U33：图片路径/文件路径，粘贴时按类型路由（text 为占位预览文本）
  source?: string; // v6.2：来源应用（场景感知建议条用）
  contentType?: string; // v6.2：内容类型（场景感知建议条用）
}

interface StatsData {
  total: number;
  pinned: number;
  today: number;
  db_size_kb: number;
  max_size_mb: number;
}

interface PopupInitData {
  name: string;
  version: string;
  monitoring: boolean;
  recents: RecentItem[];
  stats?: StatsData;
}

// ===== Toast 提示 =====
type ToastType = "success" | "error" | "info";

interface ToastState {
  visible: boolean;
  message: string;
  type: ToastType;
}

// ===== 菜单项定义 =====
interface MenuItemDef {
  id: string;
  label: string;
  hint?: string;
  danger?: boolean;
  iconClass: string;
  iconSvg: React.ReactNode;
  onClick: () => void;
}

// ===== SVG 图标组件 =====
const SvgIcon: React.FC<{ children: React.ReactNode; size?: number }> = ({ children, size = 13 }) => (
  <svg viewBox="0 0 24 24" width={size} height={size} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
    {children}
  </svg>
);

// 日历图标（今日）
const IconCalendar = () => (
  <SvgIcon size={15}>
    <rect x="3" y="4" width="18" height="18" rx="2"/>
    <line x1="16" y1="2" x2="16" y2="6"/>
    <line x1="8" y1="2" x2="8" y2="6"/>
    <line x1="3" y1="10" x2="21" y2="10"/>
  </SvgIcon>
);

// 列表图标（总计）
const IconList = () => (
  <SvgIcon size={15}>
    <line x1="8" y1="6" x2="21" y2="6"/>
    <line x1="8" y1="12" x2="21" y2="12"/>
    <line x1="8" y1="18" x2="21" y2="18"/>
    <line x1="3" y1="6" x2="3.01" y2="6"/>
    <line x1="3" y1="12" x2="3.01" y2="12"/>
    <line x1="3" y1="18" x2="3.01" y2="18"/>
  </SvgIcon>
);

// 图钉图标（置顶）
const IconPin = () => (
  <SvgIcon size={15}>
    <line x1="12" y1="17" x2="12" y2="22"/>
    <path d="M5 17h14v-1.76a2 2 0 0 0-1.11-1.79l-1.78-.9A2 2 0 0 1 15 10.76V6h1a2 2 0 0 0 0-4H8a2 2 0 0 0 0 4h1v4.76a2 2 0 0 1-1.11 1.79l-1.78.9A2 2 0 0 0 5 15.24Z"/>
  </SvgIcon>
);

// 时钟图标（最近复制标签）
const IconClock = () => (
  <SvgIcon size={11}>
    <circle cx="12" cy="12" r="10"/>
    <polyline points="12 6 12 12 16 14"/>
  </SvgIcon>
);

// 侧边栏图标（显示主窗口）
const IconSidebar = () => (
  <SvgIcon size={13}>
    <rect x="3" y="3" width="18" height="18" rx="2"/>
    <path d="M9 3v18"/>
  </SvgIcon>
);

// 暂停图标
const IconPause = () => (
  <SvgIcon size={13}>
    <rect x="6" y="4" width="4" height="16" rx="1"/>
    <rect x="14" y="4" width="4" height="16" rx="1"/>
  </SvgIcon>
);

// 设置齿轮图标
const IconSettings = () => (
  <SvgIcon size={13}>
    <circle cx="12" cy="12" r="3"/>
    <path d="M19.4 15a1.65 1.65 0 0 0 .33 1.82l.06.06a2 2 0 1 1-2.83 2.83l-.06-.06a1.65 1.65 0 0 0-1.82-.33 1.65 1.65 0 0 0-1 1.51V21a2 2 0 0 1-4 0v-.09A1.65 1.65 0 0 0 9 19.4a1.65 1.65 0 0 0-1.82.33l-.06.06a2 2 0 1 1-2.83-2.83l.06-.06A1.65 1.65 0 0 0 4.68 15a1.65 1.65 0 0 0-1.51-1H3a2 2 0 0 1 0-4h.09A1.65 1.65 0 0 0 4.6 9a1.65 1.65 0 0 0-.33-1.82l-.06-.06a2 2 0 1 1 2.83-2.83l.06.06A1.65 1.65 0 0 0 9 4.68a1.65 1.65 0 0 0 1-1.51V3a2 2 0 0 1 4 0v.09a1.65 1.65 0 0 0 1 1.51 1.65 1.65 0 0 0 1.82-.33l.06-.06a2 2 0 1 1 2.83 2.83l-.06.06A1.65 1.65 0 0 0 19.4 9a1.65 1.65 0 0 0 1.51 1H21a2 2 0 0 1 0 4h-.09a1.65 1.65 0 0 0-1.51 1z"/>
  </SvgIcon>
);

// 退出图标
const IconExit = () => (
  <SvgIcon size={13}>
    <path d="M9 21H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h4"/>
    <polyline points="16 17 21 12 16 7"/>
    <line x1="21" y1="12" x2="9" y2="12"/>
  </SvgIcon>
);

// 数据库圆柱图标（底部状态栏 — 存储占用）
const IconDatabase = () => (
  <SvgIcon size={11}>
    <ellipse cx="12" cy="5" rx="9" ry="3"/>
    <path d="M21 12c0 1.66-4 3-9 3s-9-1.34-9-3"/>
    <path d="M3 5v14c0 1.66 4 3 9 3s9-1.34 9-3V5"/>
  </SvgIcon>
);

export function TrayPopup() {
  const [appName, setAppName] = useState("PastePanda");
  const [version, setVersion] = useState("...");
  const [monitoring, setMonitoring] = useState(true);
  const [recents, setRecents] = useState<RecentItem[]>([]);
  const [stats, setStats] = useState<StatsData | null>(null);
  const [dataLoaded, setDataLoaded] = useState(false); // 初始数据是否已加载
  const [activeIdx, setActiveIdx] = useState(0); // 默认高亮第一项
  // 主题从本窗口独立 store 读取（popup-main 启动与收到 theme-changed 广播时写入），
  // 与 SkinScene 读同一份 store，保证场景与弹窗内容主题一致
  const themeKey = (useAppStore((s) => s.config.theme) || DEFAULT_THEME) as ThemeKey;
  // 审查：显示热键提示用真实配置（此前硬编码 "Ctrl+Alt+V"，用户自定义后误导）
  const showHotkey = (useAppStore((s) => s.config.hotkey) as string | undefined) || "Ctrl+Alt+V";
  const [toast, setToast] = useState<ToastState>({ visible: false, message: "", type: "info" });
  const [operationLoading, setOperationLoading] = useState<string | null>(null); // 正在执行的操作 id
  const menuRef = useRef<HTMLDivElement>(null);
  const toastTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Toast 辅助函数
  const showToast = useCallback((message: string, type: ToastType = "info", duration = 1500) => {
    if (toastTimerRef.current) clearTimeout(toastTimerRef.current);
    setToast({ visible: true, message, type });
    toastTimerRef.current = setTimeout(() => {
      setToast((prev) => ({ ...prev, visible: false }));
    }, duration);
  }, []);

  // 安全隐藏弹窗（通过 Rust 命令，避免竞态）
  const safeHide = useCallback(async () => {
    try {
      await invoke("hide_tray_popup");
    } catch {
      // 兜底：直接隐藏
      try { getCurrentWindow().hide(); } catch { /* ignore */ }
    }
  }, []);

  // 主动获取数据 + 事件监听兜底
  useEffect(() => {
    let unlisten1: UnlistenFn | null = null;
    let unlisten2: UnlistenFn | null = null;
    let cancelled = false;

    async function setup() {
      // ★ 方案1：主动 invoke 获取数据（解决时序竞态，最可靠）
      try {
        const data = await invoke<PopupInitData>("get_tray_popup_data");
        if (cancelled) return;
        setAppName(data.name || "PastePanda");
        setVersion(data.version);
        setMonitoring(data.monitoring);
        setRecents(data.recents);
        if (data.stats) {
          setStats(data.stats);
        }
      } catch (e) {
        console.warn("[TrayPopup] invoke get_tray_popup_data 失败:", e);
      } finally {
        if (!cancelled) setDataLoaded(true);
      }

      // ★ 方案2：事件监听兜底（如果 invoke 失败或后续需要更新）
      const fn1 = await listen<PopupInitData>("tray-popup-init", (event) => {
        if (cancelled) return;
        setAppName(event.payload.name || "PastePanda");
        setVersion(event.payload.version);
        setMonitoring(event.payload.monitoring);
        setRecents(event.payload.recents);
        if (event.payload.stats) {
          setStats(event.payload.stats);
        }
      });
      // 修复监听器泄漏：await listen 期间 effect 可能已被清理（卸载/StrictMode 重挂载），
      // 此时 cleanup 早已执行完毕（unlisten1 那时还是 null，绑不上），必须在这里立即自行取消，
      // 否则监听器会永久残留（原 bug：unlisten1/2 在两个 await 之后才赋值，同步 cleanup 抓不到）
      if (cancelled) {
        fn1();
      } else {
        unlisten1 = fn1;
      }

      // 监听状态变化
      const fn2 = await listen<boolean>("monitor-status-changed", (event) => {
        if (cancelled) return;
        setMonitoring(event.payload);
      });
      if (cancelled) {
        fn2();
      } else {
        unlisten2 = fn2;
      }
    }
    setup();
    return () => {
      cancelled = true;
      if (unlisten1) unlisten1();
      if (unlisten2) unlisten2();
    };
  }, []);

  // 全局鼠标按下监听 — 点击弹窗外任意位置时关闭（模拟原生右键菜单）
  // 用 mousedown 而非 click，因为 click 在失焦后可能不会被触发
  // 使用 ref 防重入：避免前端 mousedown invoke 与 Rust 失焦 hide 同时触发
  const hidingRef = useRef(false);
  useEffect(() => {
    const handleMouseDown = (e: MouseEvent) => {
      if (hidingRef.current) return; // 已在隐藏流程中
      // 如果点击的目标在弹窗内部，不处理
      if (menuRef.current && menuRef.current.contains(e.target as Node)) {
        return;
      }
      hidingRef.current = true;
      // 点击弹窗外部 → 关闭弹窗，通过 Rust 命令安全关闭
      invoke("hide_tray_popup").catch(() => {}).finally(() => {
        hidingRef.current = false;
      });
    };

    // 在捕获阶段监听，确保在 Tauri 窗口失焦之前捕获到事件
    window.addEventListener("mousedown", handleMouseDown, true);
    return () => window.removeEventListener("mousedown", handleMouseDown, true);
  }, []);

  // 操作函数（带 Toast 反馈 + 时序修复）
  const doShow = useCallback(async () => {
    setOperationLoading("show");
    try {
      // ★ 全部由 Rust show_main_window 统一处理：隐藏弹窗 → 恢复/显示主窗口 → 置顶聚焦
      await invoke("show_main_window");
    } catch (e) {
      console.error("[TrayPopup] 显示主窗口失败:", e);
      showToast("显示主窗口失败", "error");
    }
    setOperationLoading(null);
  }, [showToast]);

  const doToggleMonitor = useCallback(async () => {
    setOperationLoading("toggle_monitor");
    try {
      const newState: boolean = await invoke("toggle_monitor");
      // 更新本地状态
      setMonitoring(newState);
      const msg = newState ? "监听已恢复" : "监听已暂停";
      showToast(msg, "success", 1200);
      // 等待 toast 显示一小段时间后关闭弹窗
      setTimeout(async () => {
        await safeHide();
        setOperationLoading(null);
      }, 600);
    } catch (e) {
      console.error("[TrayPopup] 切换监听失败:", e);
      showToast("操作失败，请重试", "error");
      setOperationLoading(null);
    }
  }, [safeHide, showToast]);

  const doSettings = useCallback(async () => {
    setOperationLoading("settings");
    try {
      // ★ 先 emit 事件到主窗口（通过 Rust 命令中转，确保可靠送达）
      await invoke("emit_tray_open_settings");
      // 短暂延迟确保事件被主窗口接收
      await new Promise((r) => setTimeout(r, 50));
      // 显示主窗口
      await invoke("toggle_window");
      // 主窗口显示后再关闭弹窗
      setTimeout(async () => {
        await safeHide();
        setOperationLoading(null);
      }, 100);
    } catch (e) {
      console.error("[TrayPopup] 打开设置失败:", e);
      showToast("打开设置失败", "error");
      setOperationLoading(null);
    }
  }, [safeHide, showToast]);

  const doExit = useCallback(async () => {
    setOperationLoading("exit");
    try {
      showToast("正在退出...", "info", 800);
      // 短暂延迟让 toast 显示出来
      await new Promise((r) => setTimeout(r, 300));
      await invoke("exit_app");
    } catch (e) {
      console.error("[TrayPopup] 退出失败:", e);
      showToast("退出失败", "error");
    } finally {
      setOperationLoading(null);
    }
  }, [showToast]);

  // U33：按类型路由粘贴 — 图片走 pasteImage、文件粘贴路径（content）、文本粘贴 text，
  // 避免把"[图片] WxH"/裸文件名等占位文本打进用户文档
  const doPaste = useCallback(async (item: RecentItem) => {
    try {
      await invoke("save_foreground");
      let ok: boolean;
      if (item.type === "image" && item.content) {
        ok = await pasteImage(item.content);
      } else if (item.type === "rich" && item.content) {
        ok = await pasteRichGuarded(item.content, item.text);
      } else if (item.type === "file" && item.content) {
        ok = await pasteTextGuarded(item.content);
      } else {
        ok = await pasteTextGuarded(item.text);
      }
      // U1：仅粘贴成功时弹成功提示（pasteText/pasteImage 失败时已自行弹错误 toast）
      if (ok) showToast("已粘贴", "success", 800);
    } catch (e) {
      console.error("[TrayPopup] 粘贴失败:", e);
      showToast("粘贴失败", "error");
    }
    // 粘贴后关闭弹窗
    setTimeout(async () => {
      await safeHide();
    }, 300);
  }, [safeHide, showToast]);

  // 格式化数据库大小
  const formatDbSize = (kb: number): string => {
    if (kb < 1024) return `${kb.toFixed(1)} KB`;
    return `${(kb / 1024).toFixed(1)} MB`;
  };

  // 计算内存占用百分比（使用配置的上限，默认100MB）
  const memPercent = stats ? Math.min((stats.db_size_kb / 1024 / stats.max_size_mb) * 100, 100) : 0;

  // 构建菜单项
  // 每次渲染重建 → 下面的 keydown effect 每次都重注册（行为正确，只是白花开销）。
  // 要根治得把 doShow / doToggleMonitor / doSettings / doExit 一并 useCallback 化，
  // 不在本次 lint 清理的范围内。
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const menuItems: MenuItemDef[] = [
    {
      id: "show",
      iconClass: "icon-blue",
      iconSvg: <IconSidebar />,
      label: "显示主窗口",
      hint: showHotkey,
      onClick: doShow,
    },
    {
      id: "toggle_monitor",
      iconClass: "icon-orange",
      iconSvg: <IconPause />,
      label: monitoring ? "暂停监听" : "恢复监听",
      onClick: doToggleMonitor,
    },
    {
      id: "settings",
      iconClass: "icon-purple",
      iconSvg: <IconSettings />,
      label: "设置…",
      hint: "Ctrl+S",
      onClick: doSettings,
    },
    {
      id: "exit",
      iconClass: "icon-red",
      iconSvg: <IconExit />,
      label: "退出",
      danger: true,
      onClick: doExit,
    },
  ];

  // 键盘导航
  // 同上：随 menuItems 一起每渲染重建
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const allItems = [...recents.map((r) => ({ id: r.id, type: "recent" as const })), ...menuItems.map((m) => ({ id: m.id, type: "action" as const }))];

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === "ArrowDown") {
        e.preventDefault();
        setActiveIdx((i) => Math.min(i + 1, allItems.length - 1));
      } else if (e.key === "ArrowUp") {
        e.preventDefault();
        setActiveIdx((i) => Math.max(i - 1, 0));
      } else if (e.key === "Enter") {
        e.preventDefault();
        if (activeIdx >= 0 && activeIdx < allItems.length) {
          const item = allItems[activeIdx];
          if (item.type === "recent") {
            const recent = recents.find((r) => r.id === item.id);
            if (recent) doPaste(recent);
          } else {
            const mi = menuItems.find((m) => m.id === item.id);
            mi?.onClick();
          }
        }
      } else if (e.key === "Escape") {
        e.preventDefault();
        getCurrentWindow().hide();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [activeIdx, allItems, recents, menuItems, doPaste]);

  // 审查：内容刷新后钳制高亮（recents 变化时 activeIdx 可能指向已不存在的项）
  useEffect(() => {
    setActiveIdx((i) => Math.min(i, allItems.length - 1));
  }, [allItems.length]);

  return (
    <>
    <SkinScene />
    <div
      ref={menuRef}
      className="tray-popup-root"
      data-theme={themeKey}
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
    >
      {/* 头部信息 */}
      <div className="tray-popup-header">
        <div className="tray-popup-logo">
          <AppIcon size={22} />
        </div>
        <div className="tray-popup-title">
          <span className="tray-popup-name">{appName}</span>
          <span className="tray-popup-version">
            <VersionBadge version={version} compact />
          </span>
        </div>
        <span className={`tray-popup-status-dot ${monitoring ? "active" : ""}`} />
      </div>

      {/* 统计卡片 */}
      {!dataLoaded ? (
        <div className="tray-popup-cards">
          <div className="tray-popup-card" style={{ opacity: 0.5 }}>
            <div className="card-icon-slot"><IconCalendar /></div>
            <div className="card-value">…</div>
            <div className="card-label">今日</div>
          </div>
          <div className="tray-popup-card" style={{ opacity: 0.5 }}>
            <div className="card-icon-slot"><IconList /></div>
            <div className="card-value">…</div>
            <div className="card-label">总计</div>
          </div>
          <div className="tray-popup-card" style={{ opacity: 0.5 }}>
            <div className="card-icon-slot"><IconPin /></div>
            <div className="card-value">…</div>
            <div className="card-label">置顶</div>
          </div>
        </div>
      ) : stats ? (
        <div className="tray-popup-cards">
          <div className="tray-popup-card card-today">
            <div className="card-icon-slot">
              <IconCalendar />
            </div>
            <div className="card-value">{stats.today}</div>
            <div className="card-label">今日</div>
          </div>
          <div className="tray-popup-card card-total">
            <div className="card-icon-slot">
              <IconList />
            </div>
            <div className="card-value">{stats.total.toLocaleString()}</div>
            <div className="card-label">总计</div>
          </div>
          <div className="tray-popup-card card-pinned">
            <div className="card-icon-slot">
              <IconPin />
            </div>
            <div className="card-value">{stats.pinned}</div>
            <div className="card-label">置顶</div>
          </div>
        </div>
      ) : dataLoaded ? (
        <div className="tray-popup-cards" style={{ justifyContent: "center", opacity: 0.5 }}>
          <div className="tray-popup-card">
            <div className="card-value" style={{ fontSize: 12, color: "var(--text-muted)" }}>暂无数据</div>
            <div className="card-label">请检查数据库</div>
          </div>
        </div>
      ) : null}

      <div className="tray-popup-divider" />

      {/* 最近记录区 */}
      {recents.length > 0 ? (
        <>
          <div className="tray-popup-section-label">
            <span className="section-label-icon">
              <IconClock />
            </span>
            最近复制
          </div>
          {/* v6.2 主动建议（托盘版）：最新记录的一个最可能动作 */}
          <TrayPopupSuggestion
            item={recents[0]}
            recents={recents}
            onToast={showToast}
            onHide={safeHide}
          />
          <div className="tray-popup-recents">
            {recents.map((item, idx) => {
              const isActive = activeIdx === idx;
              const typeIcon = item.type === "image" ? "🖼" : item.type === "file" ? "📁" : "📝";
              const typeColor = item.type === "image" ? "icon-purple" : item.type === "file" ? "icon-orange" : "icon-blue";
              return (
                  <button
                    key={item.id}
                    className={`tray-popup-item${isActive ? " active" : ""}`}
                    onClick={() => doPaste(item)}
                    onMouseEnter={() => setActiveIdx(idx)}
                  >
                  <span className={`tray-popup-item-icon ${typeColor}`}>{typeIcon}</span>
                  <span className="tray-popup-item-text">{item.preview}</span>
                  <span className="tray-popup-item-hint">粘贴</span>
                </button>
              );
            })}
          </div>
          <div className="tray-popup-divider" />
        </>
      ) : (
        <div className="tray-popup-section-label" style={{ justifyContent: "center", padding: "10px 0", opacity: 0.6 }}>
          暂无最近记录
        </div>
      )}

      {/* 操作区 */}
      <div className="tray-popup-actions">
        {menuItems.map((item) => {
          const idx = recents.length + menuItems.findIndex((m) => m.id === item.id);
          const isActive = activeIdx === idx;
          const isLoading = operationLoading === item.id;
          return (
            <button
              key={item.id}
              className={`tray-popup-item${isActive ? " active" : ""}${item.danger ? " danger" : ""}${isLoading ? " loading" : ""}`}
              onClick={item.onClick}
              onMouseEnter={() => setActiveIdx(idx)}
              disabled={!!operationLoading}
            >
              <span className={`tray-popup-item-icon ${item.iconClass}`}>{item.iconSvg}</span>
              <span className="tray-popup-item-text">{isLoading ? "请稍候…" : item.label}</span>
              {item.hint && <span className="tray-popup-item-hint">{item.hint}</span>}
            </button>
          );
        })}
      </div>

      {/* 底部状态栏（方案B 两行清晰版） */}
      {dataLoaded && stats ? (
        <div className="tray-popup-footer">
          <div className="footer-row1">
            <span className="footer-icon">
              <IconDatabase />
            </span>
            <span className="footer-label">数据库存储</span>
            <span className="footer-nums">
              {formatDbSize(stats.db_size_kb)} / {stats.max_size_mb.toFixed(0)} MB · {memPercent.toFixed(1)}%
            </span>
          </div>
          <div className="footer-bar">
            <div className="footer-bar-fill" style={{ width: `${memPercent}%`, transition: "width 0.3s ease" }} />
          </div>
        </div>
      ) : dataLoaded ? (
        <div className="tray-popup-footer" style={{ justifyContent: "center", opacity: 0.5 }}>
          <span className="footer-text" style={{ fontSize: 11 }}>无法获取存储信息</span>
        </div>
      ) : (
        <div className="tray-popup-footer" style={{ justifyContent: "center", opacity: 0.5 }}>
          <span className="footer-text" style={{ fontSize: 11 }}>加载中…</span>
        </div>
      )}

      {/* Toast 提示 */}
      <div className={`tray-popup-toast ${toast.visible ? "visible" : ""} toast-${toast.type}`}>
        <span className="toast-icon">
          {toast.type === "success" ? (
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <polyline points="20 6 9 17 4 12"/>
            </svg>
          ) : toast.type === "error" ? (
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
            </svg>
          ) : (
            <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" strokeWidth="2.5" strokeLinecap="round" strokeLinejoin="round">
              <circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/>
            </svg>
          )}
        </span>
        <span className="toast-message">{toast.message}</span>
      </div>
    </div>
    </>
  );
}

export default TrayPopup;
