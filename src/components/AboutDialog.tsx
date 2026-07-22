import { motion, AnimatePresence } from "framer-motion";
import { X, ExternalLink } from "lucide-react";
import { getAppVersion, getAppName } from "@/lib/api";
import { UpdateBanner } from "@/components/UpdateBadge";
import { VersionBadge } from "@/components/VersionBadge";
import { AppIcon } from "@/components/AppIcon";
import { FocusTrap } from "@/components/FocusTrap";
import { useUpdate } from "@/contexts/UpdateContext";
import { useState, useEffect, useMemo } from "react";
import styles from "./About.module.css";

const TECH_STACK = [
  { label: "Tauri 2", desc: "桌面框架", color: "#FFC131", icon: "⚙️" as React.ReactNode },
  { label: "React 19", desc: "UI 框架", color: "#61DAFB", icon: "⚛️" as React.ReactNode },
  { label: "TypeScript", desc: "类型安全", color: "#3178C6", icon: <svg viewBox="0 0 24 24" width="18" height="18"><rect width="24" height="24" rx="3" fill="#3178C6"/><text x="12" y="17" textAnchor="middle" fontSize="11" fontWeight="700" fill="#fff" fontFamily="system-ui">TS</text></svg> as React.ReactNode },
  { label: "SQLite", desc: "本地存储", color: "#4DB8BD", icon: "🗄️" as React.ReactNode },
  { label: "Rust", desc: "后端核心", color: "#DEA584", icon: "🦀" as React.ReactNode },
  { label: "Vite", desc: "构建工具", color: "#646CFF", icon: "⚡" as React.ReactNode },
] as const;

/** 根据更新状态返回版本标签 */
function useVersionStatus() {
  const { status, update } = useUpdate();

  return useMemo(() => {
    switch (status) {
      case "checking":
        return { label: "检查中…", cls: "update", dotCls: "orange" };
      case "available":
        return { label: `v${update?.version ?? "?"} 可用`, cls: "update", dotCls: "orange" };
      case "downloading":
        return { label: "下载中…", cls: "update", dotCls: "orange" };
      case "ready":
      case "installed":
        return { label: "就绪", cls: "latest", dotCls: "green" };
      case "error":
        return { label: "错误", cls: "update", dotCls: "orange" };
      case "idle":
      default:
        return { label: "已是最新", cls: "latest", dotCls: "green" };
    }
  }, [status, update]);
}

export function AboutDialog({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [appVersion, setAppVersion] = useState("");
  const [appName, setAppName] = useState("PastePanda");
  const versionStatus = useVersionStatus();

  useEffect(() => {
    if (open) {
      getAppVersion().then(setAppVersion).catch(() => setAppVersion(""));
      getAppName().then(setAppName).catch(() => setAppName("PastePanda"));
    }
  }, [open]);

  if (!open) return null;

  const handleOpenProject = async () => {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl("https://github.com/lzlkyb/pastepanda");
    } catch (e) {
      console.warn("打开项目主页失败", e);
    }
  };

  return (
    <AnimatePresence>
      <motion.div
        initial={{ opacity: 0 }} animate={{ opacity: 1 }} exit={{ opacity: 0 }}
        className="dialog-backdrop" onClick={onClose}
      >
        <FocusTrap>
        <motion.div
          initial={{ scale: 0.96, opacity: 0, y: 10 }}
          animate={{ scale: 1, opacity: 1, y: 0 }}
          exit={{ scale: 0.96, opacity: 0, y: 10 }}
          transition={{ type: "spring", stiffness: 400, damping: 30 }}
          className="dialog-box w420 about-dialog"
          onClick={(e) => e.stopPropagation()}
        >
          {/* 头部 */}
          <div className="dialog-header">
            <h2 className="dialog-title">关于 {appName}</h2>
            <button onClick={onClose} className="dialog-close"><X size={16} /></button>
          </div>

          <div className="dialog-body" style={{ "--dialog-body-padding": "28px 28px 24px" } as React.CSSProperties}>
            {/* 英雄区 */}
            <div className={styles.aboutHero}>
              <div className={styles.aboutIcon}><AppIcon size={64} /></div>
              <div className={styles.aboutMeta}>
                <div className={styles.aboutName}>{appName}</div>
                <div className={styles.aboutVersionRow}>
                  <VersionBadge version={appVersion} />
                  <span className={`${styles.aboutVersionStatus} ${styles[versionStatus.cls]}`}>
                    <span className={`${styles.aboutStatusDot} ${styles[versionStatus.dotCls]}`} />
                    {versionStatus.label}
                  </span>
                </div>
              </div>
            </div>

            {/* 分割线 */}
            <div className={styles.aboutDivider} />

            {/* 技术栈 */}
            <div className={styles.aboutSectionLabel}>技术栈</div>
            <div className={styles.aboutTechGrid}>
              {TECH_STACK.map((t) => (
                <div key={t.label} className={styles.aboutTechCard}>
                  <div
                    className={styles.aboutTechIcon}
                    style={{ background: `${t.color}20`, color: t.color }}
                  >
                    {t.icon}
                  </div>
                  <div className={styles.aboutTechInfo}>
                    <div className={styles.aboutTechName}>{t.label}</div>
                    <div className={styles.aboutTechDesc}>{t.desc}</div>
                  </div>
                </div>
              ))}
            </div>

            {/* 更新横幅（复用现有 UpdateBanner） */}
            <UpdateBanner />

            {/* 底部 */}
            <div className={styles.aboutFooter}>
              <button className={styles.aboutFooterLink} onClick={handleOpenProject}>
                <ExternalLink size={14} />
                项目主页
              </button>
              <span className={styles.aboutCopyright}>© 2026 {appName}</span>
            </div>
          </div>
        </motion.div>
        </FocusTrap>
      </motion.div>
    </AnimatePresence>
  );
}
