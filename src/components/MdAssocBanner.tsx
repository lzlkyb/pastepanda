import { memo, useCallback, useEffect, useState } from "react";
import { useWindowVisible } from "@/hooks/useWindowVisible";
import { motion, AnimatePresence } from "framer-motion";
import { FileText, X } from "lucide-react";
import { useToast } from "@/components/Toast";
import { useFirstTimeTip } from "@/hooks/useFirstTimeTip";
import { logger } from "@/lib/logger";
import styles from "./MdAssocBanner.module.css";

/** 一次性提示的标识（写入 localStorage，点过「不再提示」后永不再弹） */
const TIP_ID = "md_assoc_guide";

/**
 * .md 文件关联引导横幅（方案 A）
 * 与 StackBanner 同构：渲染在滚动区外的固定节点，不随列表滚动。
 * 触发条件：关联状态 ≠ 默认 且 用户未点过「不再提示」。
 * - 「去设置」→ set_md_association(true) 唤起系统确认页
 * - 可见期间每 2s 轮询 + 窗口获焦刷新，用户确认成功后（状态=default）自动消失
 */
export const MdAssocBanner = memo(function MdAssocBanner() {
  const { toast } = useToast();
  const { shouldShow, markShown } = useFirstTimeTip();

  // 关联状态：default（已是默认）| registered（已注册未默认）| unregistered（未注册）
  const [status, setStatus] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [dismissed, setDismissed] = useState(() => !shouldShow(TIP_ID));

  const refresh = useCallback(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const s = await invoke<string>("get_md_association_status");
      setStatus(s);
    } catch {
      /* 查询失败保持当前状态 */
    }
  }, []);

  useEffect(() => { void refresh(); }, [refresh]);

  // 用户去系统设置确认后返回，窗口获焦时自动刷新；确认成功（default）则横幅消失
  useEffect(() => {
    const onFocus = () => void refresh();
    window.addEventListener("focus", onFocus);
    return () => window.removeEventListener("focus", onFocus);
  }, [refresh]);

  // 横幅可见期间每 2s 轮询一次，关联一生效立即消失（不完全依赖窗口焦点事件）
  const visible = !dismissed && status !== null && status !== "default";
  // 窗口隐藏（hide()）时暂停轮询：WebView 仍存活，空转会烧 CPU（claude.md 规则 8）
  const winVisible = useWindowVisible();
  useEffect(() => {
    if (!visible || !winVisible) return;
    const timer = setInterval(() => void refresh(), 2000);
    return () => clearInterval(timer);
  }, [visible, winVisible, refresh]);

  const handleGo = async () => {
    if (busy) return;
    setBusy(true);
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      await invoke("set_md_association", { enable: true });
      toast("已注册 .md 打开方式，请在设置页中点击 .md 一行并选择 PastePanda", "success");
      await refresh();
    } catch (e) {
      logger.warn("设置 .md 关联失败", e);
      toast(".md 文件关联设置失败", "error");
    } finally {
      setBusy(false);
    }
  };

  const handleDismiss = () => {
    markShown(TIP_ID);
    setDismissed(true);
  };

  // 已是默认 / 已拒绝 / 状态未知（加载中）→ 不渲染（由下方 AnimatePresence 门控以支持退场）
  return (
    <AnimatePresence>
      {visible && (
        <motion.div
          className={styles.banner}
          exit={{
            opacity: 0,
            height: 0,
            paddingTop: 0,
            paddingBottom: 0,
            marginBottom: 0,
            overflow: "hidden",
            transition: { duration: 0.2, ease: "easeIn" },
          }}
        >
          <span className={styles.icon}>
            <FileText size={15} strokeWidth={2.2} />
          </span>
          <div className={styles.text}>
            <div className={styles.title}>将 PastePanda 设为默认 Markdown 编辑器？</div>
            <div className={styles.sub}>双击 .md 文件直接用全屏编辑器打开</div>
          </div>
          <button className={styles.dismissBtn} onClick={handleDismiss}>不再提示</button>
          <button className={styles.goBtn} onClick={() => void handleGo()} disabled={busy}>
            {busy ? "设置中…" : "去设置"}
          </button>
          <button className={styles.closeBtn} onClick={handleDismiss} title="关闭">
            <X size={12} />
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
});
