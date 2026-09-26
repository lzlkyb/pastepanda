/**
 * FullscreenEditor —— 独立 OS 全屏窗口（label = `md-editor`）的**宿主**（多标签）。
 *
 * 改造前这个文件是「窗口 + 单文档」一体的（1061 行）。现在按职责切成六块，
 * 本文件只负责**编排 + 渲染**，自身不含业务逻辑：
 *
 *   本文件（宿主）          标签状态 → 各 hook 的连线 → 渲染
 *   useEditorTabs           标签列表 / 活动标签 / 元信息上报（状态容器）
 *   useEditorBootstrap      与 Rust 的会话对接（建窗期队列 / md-editor-load / 编辑器目标）
 *   useEditorCloseGuard     关闭守卫（脏标签聚合清单、最后一个标签=关窗、保存失败不关）
 *   useEditorWindowState    窗口级主题明暗 + 全屏态 + 全屏/最小化
 *   useEditorWindowKeys     窗口级快捷键（Ctrl+W/T/Tab/1-9）
 *   EditorDocument          一个标签的视图容器（保活：非活动只 display:none）
 *   CodeDocument            CodeMirror 单栏族的单文档视图（原 FullscreenInner）
 *   FullscreenShell         rich / diagram / diff 三类共用的壳（带标签栏插槽）
 *
 * 依赖方向是单向的：宿主 → 各 hook → 纯逻辑（`@/lib/editorTabs`）。
 * 拆分把每个 hook 压回规则 7 的体量红线内（本文件 1061 → ~200 行）。
 */
import { useCallback, useEffect, useState } from "react";
import { MAX_EDITOR_TABS, tabLimitMessage } from "@/lib/editorTabs";
import { useToast } from "@/components/Toast";
import { EditorDocument } from "./EditorDocument";
import { TabBar, type TabItem } from "./fullscreen/TabBar";
import { CloseAllDialog } from "./fullscreen/CloseAllDialog";
import { useEditorTabs } from "./fullscreen/useEditorTabs";
import { useEditorBootstrap } from "./fullscreen/useEditorBootstrap";
import { useEditorCloseGuard } from "./fullscreen/useEditorCloseGuard";
import { useEditorWindowState } from "./fullscreen/useEditorWindowState";
import { useEditorWindowKeys } from "./fullscreen/useEditorWindowKeys";
import styles from "./FullscreenEditor.module.css";

export function FullscreenEditor() {
  const { toast } = useToast();
  const { tabs, activeId, activeIdRef, tabsRef, open, close, select, updateMeta } = useEditorTabs();
  /** 引导是否已结束（见 `useEditorBootstrap` 的 `onBooted`）。用来区分「还在加载」与「初始化失败」 */
  const [booted, setBooted] = useState(false);

  const { darkMode, isFullscreen, toggleFullscreen, minimize } = useEditorWindowState();
  const guard = useEditorCloseGuard({ tabs, tabsRef, close });
  const { requestCloseWindow } = guard;
  /** 稳定引用：它进 bootstrap 的 effect 依赖数组，换引用会重跑整个引导 */
  const handleBooted = useCallback(() => setBooted(true), []);
  useEditorBootstrap({
    open,
    tabsRef,
    tabs,
    activeId,
    resetClosing: guard.resetClosing,
    onBooted: handleBooted,
  });

  /**
   * 兜底：引导结束却一个标签都没有 → 这个窗口已无可显示的内容，主动关掉。
   *
   * ❗ 少了这条，任何一条初始化失败路径都会把窗口永久留在**无标签死态**：
   * 窗口弹出来、一屏「加载中…」、再也没有下文，用户既没内容可看也没有出口。
   * `requestCloseWindow` 幂等（退场定时器即防重入判据），重复触发无害。
   */
  useEffect(() => {
    if (booted && tabs.length === 0) requestCloseWindow();
  }, [booted, tabs.length, requestCloseWindow]);

  const handleNewTab = useCallback(() => {
    const res = open({ content: "", contentType: "markdown", language: null });
    if (!res.accepted) toast(tabLimitMessage(), "info");
  }, [open, toast]);

  useEditorWindowKeys({
    activeIdRef,
    tabsRef,
    select,
    requestCloseTab: guard.requestCloseTab,
    onNewTab: handleNewTab,
  });

  // ─── Render ─────────────────────────────────────────
  // 「一个标签都没有」有两种含义，必须分开渲染 —— 都画成「加载中…」会让
  // **初始化失败伪装成「还在加载」**，窗口永远停着、用户没有出口：
  //   ① 引导还没结束   → 确实在加载，画加载态
  //   ② 引导结束却没标签 → 初始化失败，上面的兜底会主动关窗；这帧只留空壳，
  //                        连退场类一起挂上，让关窗走正常动画
  // 正常关闭**不会**走到这里：关最后一个标签时刻意不移除它（见 useEditorCloseGuard），
  // 整窗带着内容一起退场，不会先闪出一个空壳。
  if (tabs.length === 0) {
    if (!booted) {
      // 包 windowRoot：入场动画（窗口浮升）播在这一层，从「加载中」切到内容时
      // 该元素被 React 复用、动画不会重播 —— 窗口只浮入一次。
      return (
        <div className={styles.windowRoot}>
          <div className={styles.overlay}>
            <div className={styles.loading}>加载中…</div>
          </div>
        </div>
      );
    }
    return (
      <div className={`${styles.windowRoot}${guard.closing ? ` ${styles.windowExit}` : ""}`} />
    );
  }

  const activeTab = tabs.find((t) => t.id === activeId) ?? null;
  // 单标签不渲染标签栏（1 个标签的横条是纯噪音，信息工具栏里已经有了）；
  // 专注模式同样隐藏（chrome 全隐藏是那个模式的定义）。
  const showTabBar = tabs.length >= 2 && !(activeTab?.meta.focusMode ?? false);
  const tabItems: TabItem[] = tabs.map((t) => ({
    id: t.id,
    fileName: t.meta.fileName,
    icon: t.meta.icon,
    isDirty: t.meta.isDirty,
    tabError: t.meta.tabError,
  }));
  const tabBarNode = showTabBar ? (
    <TabBar
      tabs={tabItems}
      activeId={activeId}
      onSelect={select}
      onClose={guard.requestCloseTab}
      onNew={handleNewTab}
      canAdd={tabs.length < MAX_EDITOR_TABS}
      maxTabs={MAX_EDITOR_TABS}
    />
  ) : undefined;

  return (
    <div className={`${styles.windowRoot}${guard.closing ? ` ${styles.windowExit}` : ""}`}>
      {tabs.map((t) => {
        const isActive = t.id === activeId;
        return (
          <EditorDocument
            key={t.id}
            tab={t}
            active={isActive}
            darkMode={darkMode}
            isFullscreen={isFullscreen}
            onFullscreenToggle={toggleFullscreen}
            onMinimize={minimize}
            onRequestClose={() => guard.requestCloseTab(t.id)}
            onMeta={(meta) => updateMeta(t.id, meta)}
            registerSave={(fn) => guard.registerSave(t.id, fn)}
            tabBar={isActive ? tabBarNode : undefined}
          />
        );
      })}

      <CloseAllDialog
        open={!!guard.closeIntent}
        scope={guard.closeIntent?.scope ?? "tab"}
        targets={guard.closeTargets}
        busy={guard.closeBusy}
        onSaveAll={() => void guard.saveAll()}
        onDiscard={guard.discard}
        onCancel={guard.cancelClose}
      />
    </div>
  );
}
