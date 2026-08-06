/**
 * 图文混排（rich）的全屏编辑形态。
 *
 * 为什么不走 fullscreen/registry 那套：那张表存的是 CodeMirror 专用的
 * Extension / 语言模式 / 分屏预览配置，类型上就跟 Tiptap 对不上。
 * 所以只复用外层窗口壳（独立 OS 窗口 / 开关与复用逻辑 / 拖拽区 / 主题），
 * 内部完全绕开 CodeMirror 路径，对其它类型（text/json/csv/markdown）零影响。
 *
 * 样式复用 FullscreenEditor.module.css，保证工具栏观感与其它类型全屏一致。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { Save, X, Maximize2, Minimize2 } from "lucide-react";
import { getCurrentWindow } from "@tauri-apps/api/window";
import { invoke } from "@tauri-apps/api/core";
import { useToast } from "@/components/Toast";
import { ConfirmDialog } from "@/components/ConfirmDialog";
import { SkinScene } from "@/components/SkinScene";
import { RichContentEditor } from "@/components/editors/RichEditor";
import { richToPlainText } from "@/lib/richContent";
import { logger } from "@/lib/logger";
import styles from "../FullscreenEditor.module.css";
import richStyles from "../RichEditor.module.css";

export function RichFullscreen({
  sourceId,
  initContent,
  onClose,
}: {
  /** 来源卡片 id（为空时不可保存——图文内容没有“存为文件”这条路） */
  sourceId: string | null;
  initContent: string | null;
  onClose: () => void;
}) {
  const { toast } = useToast();
  const originalHtml = initContent || "";
  const [html, setHtml] = useState(originalHtml);
  const [isFullscreen, setIsFullscreen] = useState(false);
  const [showConfirmClose, setShowConfirmClose] = useState(false);
  // 编辑器明暗：默认暗（与外壳一致），读到实际主题后再校正
  const [isDarkTheme, setIsDarkTheme] = useState(true);

  const htmlRef = useRef(html);
  htmlRef.current = html;

  const isDirty = html !== originalHtml;
  const isDirtyRef = useRef(isDirty);
  isDirtyRef.current = isDirty;

  // 读主题校正明暗（独立窗口拿不到主窗口 store，只能走 get_config）
  useEffect(() => {
    invoke<Record<string, unknown>>("get_config")
      .then((cfg) => {
        const theme = String(cfg?.theme ?? "");
        // 与主窗口同口径：只有这两个是暗色主题
        setIsDarkTheme(theme === "midnight" || theme === "ocean-dark" || theme === "");
      })
      .catch(() => { /* 读不到就保持默认暗色 */ });
  }, []);

  const handleSave = useCallback(async (): Promise<boolean> => {
    if (!sourceId) {
      toast("无来源记录，无法保存", "error");
      return false;
    }
    try {
      const stored = htmlRef.current;
      await invoke("update_history_rich", {
        id: sourceId,
        htmlFragment: stored,
        plainText: richToPlainText(stored),
      });
      toast("已保存", "success");
      return true;
    } catch (e) {
      logger.error("图文全屏保存失败", e);
      toast("保存失败: " + (e instanceof Error ? e.message : String(e)), "error");
      return false;
    }
  }, [sourceId, toast]);

  /** 关闭守卫：有未保存修改先弹确认，避免辛苦排版完一下子没了 */
  const guardedClose = useCallback(() => {
    if (isDirtyRef.current) {
      setShowConfirmClose(true);
      return;
    }
    onClose();
  }, [onClose]);

  const toggleFullscreen = useCallback(async () => {
    try {
      const win = getCurrentWindow();
      const next = !(await win.isFullscreen());
      await win.setFullscreen(next);
      setIsFullscreen(next);
    } catch (e) {
      logger.error("切换全屏失败", e);
    }
  }, []);

  // 快捷键：Ctrl+S 保存 / Esc 关闭（与其它类型全屏一致）
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === "s") {
        e.preventDefault();
        handleSave();
        return;
      }
      if (e.key === "Escape") {
        e.preventDefault();
        guardedClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleSave, guardedClose]);

  return (
    <div className={styles.overlay} data-theme-mode={isDarkTheme ? "dark" : "light"}>
      <SkinScene />
      <div className={styles.toolbar} data-tauri-drag-region="deep">
        <div className={styles.toolbarLeft}>
          <div className={styles.fileIcon}>🖼️</div>
          <span className={styles.fileName}>{sourceId ? "剪贴板图文" : "图文内容"}</span>
          {isDirty && <div className={styles.unsavedDot} />}
        </div>
        <div className={styles.toolbarRight}>
          <button
            className={`${styles.tbBtn} ${styles.tbBtnPrimary}`}
            onClick={handleSave}
            title="保存 Ctrl+S"
          >
            <Save size={14} />
            <span>保存</span>
          </button>
          <div className={styles.tbSep} />
          <button
            className={styles.tbBtnIcon}
            onClick={toggleFullscreen}
            title={isFullscreen ? "缩回窗口" : "放大到真全屏"}
          >
            {isFullscreen ? <Minimize2 size={15} /> : <Maximize2 size={15} />}
          </button>
          <button
            className={`${styles.tbBtnIcon} ${styles.tbBtnClose}`}
            onClick={guardedClose}
            title="关闭 Esc"
          >
            <X size={15} />
          </button>
        </div>
      </div>

      <div className={richStyles.fullscreenWrap}>
        <RichContentEditor initialHtml={originalHtml} onChange={setHtml} />
      </div>

      <ConfirmDialog
        open={showConfirmClose}
        title="有未保存的修改"
        message="关闭后本次编辑将丢弃，确定关闭吗？"
        confirmText="不保存关闭"
        cancelText="继续编辑"
        variant="danger"
        onConfirm={() => {
          setShowConfirmClose(false);
          onClose();
        }}
        onCancel={() => setShowConfirmClose(false)}
      />
    </div>
  );
}
