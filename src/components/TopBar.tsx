import { configuredShortcutLabel } from "@/lib/utils";
import { useState, useEffect, useRef, useCallback } from "react";
import { useAppStore } from "@/stores/appStore";
import { HistoryTimeFilter } from "@/components/history-time/HistoryTimeFilter";
import { AiStatusCap } from "@/components/AiStatusCap";
import { AiStatusDot } from "@/components/AiStatusDot";
import { AiMark } from "@/components/ai/AiMark";
import { getAppName, fetchCounts, toggleStackMode } from "@/lib/api";
import { HistorySourceFilter } from "@/components/history-source/HistorySourceFilter";
import { UpdateBadge } from "@/components/UpdateBadge";
import { ModeSwitcher } from "@/components/ModeSwitcher";
import { AppIcon } from "@/components/AppIcon";
import { SearchBox } from "@/components/SearchBox";
import { setTopBarSlot } from "@/lib/topbarSlot";
import { logger } from "@/lib/logger";
import { EyeOff } from "lucide-react";
import styles from "./TopBar.module.css";
import { HistoryFilterBar } from "./history-filter/HistoryFilterBar";




/* 工具箱已整体离开顶栏：D15 把它从下拉面板改成了「工具」模式的主体区。
   条目数据在 `@/lib/toolbox`（一模一样搬过去的），渲染在 `ToolboxView`，
   回调由 App.tsx 直接传给它——所以顶栏不再需要 onSequential / onSnippets / … 那一排 props。 */

async function minimizeWin() {
  try { (await import("@tauri-apps/api/window")).getCurrentWindow().minimize(); } catch { logger.warn("窗口最小化失败"); }
}
async function hideWin() {
  // U6：首次隐藏时先派发提示并延迟隐藏，确保提示真正被看到
  // （原实现先 hide() 再派发事件，toast 渲染在已隐藏窗口里永远不可见，却已标记"已展示"）
  const KEY = "pastepanda_hidden_tip_shown";
  let firstHide = false;
  try { firstHide = !localStorage.getItem(KEY); } catch { /* ignore */ }
  if (firstHide) {
    window.dispatchEvent(new CustomEvent("first-time-tip", { detail: { id: "hide_window", message: "窗口已隐藏到托盘，右键托盘图标可退出或重新打开", type: "info" } }));
    try { localStorage.setItem(KEY, "1"); } catch { /* ignore */ }
    await new Promise((r) => setTimeout(r, 2000)); // 留出阅读提示的时间
  }
  try { (await import("@tauri-apps/api/window")).getCurrentWindow().hide(); } catch { logger.warn("窗口隐藏失败"); }
}

type TabStyle = "segmented" | "circle";

function getTabStyle(): TabStyle {
  try { return (localStorage.getItem("tabStyle") as TabStyle) || "segmented"; } catch { return "segmented"; }
}

export function TopBar({ onSettings, settingsOpen = false }: {
  onSettings?: () => void;
  /**
   * 设置视图是否正占着内容区。为 true 时隐掉**模式切换器与搜索/页签行**：
   * 那两样都是「记录模式」的东西，在设置里既无指向又让人以为还在记录页。
   *
   * 🔴 顶栏外壳（图标/名称/最小化/隐藏）**不能**一并藏：主窗口是
   * `decorated: false` 的无边框窗，这一条兼着 data-tauri-drag-region 拖动区
   * 与仅有的两个窗口控制按钮，藏了就拖不动也最小化不了。
   */
  settingsOpen?: boolean;
}) {
  const appMode = useAppStore((s) => s.appMode);
  // 侧栏开合直接读 store，不走 props：按钮要反映的是**当前模式**那一份，
  // 父层传一个固定的就会变成「在知识模式下显示的是记录模式的状态」。
  const sidebarOpen = useAppStore((s) => (s.appMode === "tools" ? false : s.sidebarOpen[s.appMode]));
  const onToggleSidebar = useAppStore((s) => s.toggleSidebar);
  const ws = useAppStore((s) => s.config.current_workspace);
  const stackMode = useAppStore((s) => s.stackMode);
  // 只订阅条数而不是整个 stackItems：这一行只用来拼提示文案，
  // 订阅数组会让每收集一条就重渲染整个顶栏。
  const stackCount = useAppStore((s) => s.stackItems.length);
  const stackToggleHotkey = useAppStore((s) => s.config.stack_toggle_hotkey);
  const [tabStyle, setTabStyle] = useState<TabStyle>(getTabStyle);
  const [appName, setAppName] = useState("PastePanda");
  const [counts, setCounts] = useState<Record<string, number> | null>(null);
  const [countsError, setCountsError] = useState(false);

  useEffect(() => {
    getAppName().then((name) => {
      setAppName(name);
      document.title = name;
    }).catch(() => setAppName("PastePanda"));
  }, []);

  // 从后端获取计数（带 30s 缓存）
  // cancelRef 始终持有“最近一次” refreshCounts 调用的取消函数，
  // 保证任意时刻最多只有一个 fetchCounts 结果能够生效：
  // 每次发起新请求前先取消上一个仍在途的请求，避免旧请求晚回导致覆盖新结果的竞态。
  const cancelRef = useRef<(() => void) | null>(null);
  const refreshCounts = useCallback(() => {
    cancelRef.current?.();
    let cancelled = false;
    fetchCounts(ws).then(c => {
      if (!cancelled) { setCounts(c); setCountsError(false); }
    }).catch(() => {
      if (!cancelled) setCountsError(true);
    });
    const cancel = () => { cancelled = true; };
    cancelRef.current = cancel;
    return cancel;
  }, [ws]);

  useEffect(() => {
    refreshCounts();
    return () => { cancelRef.current?.(); };
  }, [refreshCounts]);

  // 监听缓存失效事件，实时刷新计数
  useEffect(() => {
    const handler = () => { refreshCounts(); };
    window.addEventListener("counts-invalidated", handler);
    return () => window.removeEventListener("counts-invalidated", handler);
  }, [refreshCounts]);

  // 监听 localStorage 变化（SettingsDialog 更新 tabStyle 时触发）
  useEffect(() => {
    const handler = (e: StorageEvent) => {
      if (e.key === "tabStyle" && e.newValue) {
        setTabStyle(e.newValue as TabStyle);
      }
    };
    window.addEventListener("storage", handler);
    return () => window.removeEventListener("storage", handler);
  }, []);

  return (
    <div className={styles.header} data-mode={appMode} data-tauri-drag-region role="banner">
      {/* 标题行 */}
      <div className={styles.headerTop} data-tauri-drag-region>
        <div className={styles.headerTitle}>
          {/* 侧栏开关的**唯一入口**：点它切当前模式的侧栏
              （记录 = 分组导航，知识 = 文件夹树）。

              ❗ 原注释写的是「侧栏只属于记录模式，在工具/知识下无意义」——
              那句话在知识模式长出文件夹树之后就不成立了，而当时的实际效果是：
              这里置灰并提示「没有侧边栏」，而侧边栏就在下面、只是开关在别处。

              工具模式确实没侧栏，仍然禁用而不隐藏（隐藏会让标题行左侧宽度跳一下）。 */}
          <button
            className={`${styles.sidebarToggle}${sidebarOpen ? ` ${styles.sidebarToggleActive}` : ""}`}
            onClick={onToggleSidebar}
            disabled={appMode === "tools" || settingsOpen}
            title={
              settingsOpen
                ? "设置页没有侧边栏"
                : appMode === "tools"
                ? "工具模式没有侧边栏"
                : appMode === "knowledge"
                  ? sidebarOpen
                    ? "收起文件夹"
                    : "展开文件夹"
                  : sidebarOpen
                    ? "收起侧边栏"
                    : "展开侧边栏"
            }
            aria-label="切换侧边栏"
          >
            ☰
          </button>
          <span className={styles.headerTitleIcon}><AppIcon size={20} /></span>
          {/* 名位复用（D15）：应用名与更新状态共用这一个位置。
              为何把名字作为 prop 交给 UpdateBadge 而不是并列两个节点：
              只有它知道当前更新状态，只有它能在同一个 AnimatePresence 里做淡入淡出；
              而名字的样式属于本文件的 CSS module，所以节点在这里拼。 */}
          <UpdateBadge
            nameSlot={
              <span className={styles.brandTitle}>
                <span className={styles.headerTitleText}>{appName}</span>
                {/* 品牌标识：这个产品是 AI 的。不可点、不随 AI 配置状态变化——
                    「配好了没」由右侧 AiStatusCap / AiStatusDot 承担，两者不重叠。
                    上标随名字一起让位，不能留在外面——否则下载态会渲染成 `v6.18.6ᴬᴵ`。 */}
                <AiMark shape="sup" text="AI" title="PastePanda 的能力由 AI 驱动" />
              </span>
            }
          />
          {/* 三模式切换器（D15）：站在应用名右侧，宽度正好是名位复用省下的那一块。
              设置打开时不渲染：那时内容区是设置，再摆一个「记录|工具|知识」会让人以为还在记录页 */}
          {!settingsOpen && <ModeSwitcher />}
        </div>
        <div className={styles.headerIcons} data-tauri-drag-region="false">
          {/* ===== 模式专属段 =====
              这一段随模式换内容；下面从 AiStatusCap 起是三模式恒定的全局段。

              栈模式按钮的条件**不能**只写 `appMode === "record"`。
              粘贴栈是**全局后台状态**、不是记录模式的局部 UI：它有全局快捷键
              （stack_toggle_hotkey，默认 ctrl+alt+k），主窗口关着也能开；一旦开着，
              用户复制的每一条都进队列（appStore.stackPush），与当前在看哪个模式无关。

              🔴 所以其它模式下「开着就必须还看得见」：队列条 StackBanner 挂在 CardList 里，
              切走记录模式它就没了——按钮再一起藏掉的话，东西还在往队列里堆，
              但屏幕上零线索、零关闭入口，只剩用户未必记得的快捷键。
              （同一类错误：把状态的唯一出口藏起来。）

              onClick 两种情形共用 toggleStackMode：非记录模式下它只在 stackMode 为真时
              渲染，所以 toggle 恰好就是「退出」，不需要再分支。 */}
          {((appMode === "record" && !settingsOpen) || stackMode) && (
          <IconBtn
            tip={
              appMode === "record" && !settingsOpen
                ? `收集模式（栈模式）· ${configuredShortcutLabel(stackToggleHotkey, "ctrl+alt+k")}${stackMode ? " · 已开启" : ""}`
                : `粘贴栈收集中（${stackCount} 条）· 点击退出`
            }
            active={stackMode}
            hue="amber"
            onClick={() => toggleStackMode()}
          >
            {/* 定制双色调图标（方案 B）：顶层实心 + 下层渐淡描边，currentColor 自动跟随主题与激活态 */}
            <svg className={styles.iconSvg} viewBox="0 0 24 24" fill="none" aria-hidden="true">
              <path d="M12 2.6 2.9 7.66a.95.95 0 0 0 0 1.68L12 14.4l9.1-5.06a.95.95 0 0 0 0-1.68Z" fill="currentColor" fillOpacity=".88" />
              <path d="m3.2 12.4 8.8 4.9 8.8-4.9" stroke="currentColor" strokeOpacity=".5" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
              <path d="m3.2 16.9 8.8 4.9 8.8-4.9" stroke="currentColor" strokeOpacity=".26" strokeWidth="2.1" strokeLinecap="round" strokeLinejoin="round" />
            </svg>
          </IconBtn>
          )}
          {/* 各模式自己的按钮投在这里（知识模式 = 「⋯ 更多」）。
              空着时零宽，所以工具模式与设置页这一段等于不存在——右侧组整体右贴边，
              少一格只让组变窄，设置/最小化/隐藏纹丝不动。
              为何要绕 portal 而不是在这里直接写：见 @/lib/topbarSlot 头部。 */}
          <span ref={setTopBarSlot} className={styles.modeSlot} />
          {/* 工具箱按钮已撤掉：它现在是「工具」模式，从标题行的模式切换器进（D15） */}
          {/* v6.4 主窗口 AI 感知（方案 A）：胶囊 —— 未配置=引流入口；已配置=不渲染（状态收进设置按钮绿点） */}
          <AiStatusCap />
          {/* 剪贴板同步已挪到记录模式标签筛选行最右侧（不再顶栏常驻） */}
          {/* 审查方案 1：设置按钮带 AI 状态绿点 —— 已就绪时右上角一个 6px 绿点（hover 看详情），
              不占额外空间，能力入口在快捷区 */}
          <span className={styles.settingsWrap}>
            <IconBtn tip="设置 · 帮助 · 关于" hue="violet" onClick={onSettings}>
              <svg className={styles.iconSvg} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M12.22 2h-.44a2 2 0 0 0-2 2v.18a2 2 0 0 1-1 1.73l-.43.25a2 2 0 0 1-2 0l-.15-.08a2 2 0 0 0-2.73.73l-.22.38a2 2 0 0 0 .73 2.73l.15.1a2 2 0 0 1 1 1.72v.51a2 2 0 0 1-1 1.74l-.15.09a2 2 0 0 0-.73 2.73l.22.38a2 2 0 0 0 2.73.73l.15-.08a2 2 0 0 1 2 0l.43.25a2 2 0 0 1 1 1.73V20a2 2 0 0 0 2 2h.44a2 2 0 0 0 2-2v-.18a2 2 0 0 1 1-1.73l.43-.25a2 2 0 0 1 2 0l.15.08a2 2 0 0 0 2.73-.73l.22-.39a2 2 0 0 0-.73-2.73l-.15-.08a2 2 0 0 1-1-1.74v-.5a2 2 0 0 1 1-1.74l.15-.09a2 2 0 0 0 .73-2.73l-.22-.38a2 2 0 0 0-2.73-.73l-.15.08a2 2 0 0 1-2 0l-.43-.25a2 2 0 0 1-1-1.73V4a2 2 0 0 0-2-2z"/><circle cx="12" cy="12" r="3"/></svg>
            </IconBtn>
            <AiStatusDot />
          </span>
          {/* 分隔线：功能按钮组（栈模式/工具箱/设置）与窗口控制组（最小化/隐藏）分开 */}
          <span className={styles.headerDivider} aria-hidden="true" />
          <IconBtn tip="最小化到任务栏" onClick={minimizeWin}>
            <svg className={styles.iconSvg} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round"><path d="M5 12h14"/></svg>
          </IconBtn>
          <IconBtn tip="隐藏到托盘（保持后台运行）" onClick={hideWin}>
            <EyeOff className={styles.iconSvg} strokeWidth="2" />
          </IconBtn>
        </div>
      </div>

      {/* 搜索框 + Tab 在同一个容器内，保证宽度完全一致 */}
      {/* 搜索行与页签行只属于「记录」模式（D15）。
          工具模式：两行都不渲染——工具既不需要按内容类型筛，也没有可搜的东西；
          知识模式：A 阶段也不渲染。设计稿原本写「搜索行换文案」，但 notes 表还没建，
          摆一个搜不到任何东西的搜索框是假 UI。等 §8.1 2️⃣ 建表后再加。 */}
      {appMode === "record" && !settingsOpen && (
      <div className={styles.headerControls}>
        {/* 搜索 + 时间/来源筛选同行（方案 A：筛选并入搜索行，省一行垂直空间） */}
        <div className={styles.searchFilterRow} data-tauri-drag-region="false">
          <SearchBox fill />
          <HistoryTimeFilter />
          <HistorySourceFilter />
        </div>

        <HistoryFilterBar tabStyle={tabStyle} counts={counts} countsError={countsError} refreshCounts={refreshCounts} />
      </div>
      )}
    </div>
  );
}


function IconBtn({ children, tip, danger, active, hue, onClick, ariaLabel }: {
  children: React.ReactNode; tip: string; danger?: boolean; active?: boolean;
  /** 功能键默认色相（配色方案 B）：CSS 属性选择器映射固定色，复用工具箱瓷砖调色板 */
  hue?: "amber" | "sky" | "violet";
  onClick?: () => void; ariaLabel?: string;
}) {
  return (
    <button title={tip} aria-label={ariaLabel || tip} onClick={onClick} aria-expanded={active} data-hue={hue}
      className={`${styles.iconBtn}${danger ? ` ${styles.iconBtnDanger}` : ""}${active ? ` ${styles.iconBtnActive}` : ""}`}>
      {children}
    </button>
  );
}
