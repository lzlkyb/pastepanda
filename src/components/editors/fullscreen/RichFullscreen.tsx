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
import { useCallback, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { useToast } from "@/components/Toast";
import { RichContentEditor } from "@/components/editors/RichEditor";
import { richToPlainText } from "@/lib/richContent";
import { logger } from "@/lib/logger";
import { FullscreenShell } from "../FullscreenShell";
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

  const htmlRef = useRef(html);
  htmlRef.current = html;

  const isDirty = html !== originalHtml;

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

  return (
    <FullscreenShell
      icon="🖼️"
      title={sourceId ? "剪贴板图文" : "图文内容"}
      dirty={isDirty}
      onSave={handleSave}
      onClose={onClose}
    >
      <div className={richStyles.fullscreenWrap}>
        <RichContentEditor initialHtml={originalHtml} onChange={setHtml} />
      </div>
    </FullscreenShell>
  );
}
