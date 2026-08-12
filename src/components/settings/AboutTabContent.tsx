import { useMemo } from "react";
import { ExternalLink } from "lucide-react";
import { useUpdate } from "@/contexts/UpdateContext";
import { useAppStore } from "@/stores/appStore";
import { VersionBadge } from "@/components/VersionBadge";
import { UpdateBanner } from "@/components/UpdateBadge";
import { AppIcon } from "@/components/AppIcon";
import { ChangelogView } from "@/components/ChangelogView";
import aboutStyles from "../About.module.css";
import melodyUrl from "@/assets/melody.png";

const TECH_STACK = [
  { label: "Tauri 2", desc: "桌面框架", color: "#FFC131", icon: "⚙️" as React.ReactNode },
  { label: "React 19", desc: "UI 框架", color: "#61DAFB", icon: "⚛️" as React.ReactNode },
  { label: "TypeScript", desc: "类型安全", color: "#3178C6", icon: <svg viewBox="0 0 24 24" width="18" height="18"><rect width="24" height="24" rx="3" fill="#3178C6"/><text x="12" y="17" textAnchor="middle" fontSize="11" fontWeight="700" fill="#fff" fontFamily="system-ui">TS</text></svg> as React.ReactNode },
  { label: "SQLite", desc: "本地存储", color: "#4DB8BD", icon: "🗄️" as React.ReactNode },
  { label: "Rust", desc: "后端核心", color: "#DEA584", icon: "🦀" as React.ReactNode },
  { label: "Vite", desc: "构建工具", color: "#646CFF", icon: "⚡" as React.ReactNode },
] as const;

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

export function AboutTabContent({ appName, appVersion }: { appName: string; appVersion: string }) {
  const versionStatus = useVersionStatus();
  // 审查：错误态给重试（此前只有"错误"文案无恢复入口）
  const { status, checkForUpdate } = useUpdate();
  const theme = useAppStore((s) => s.config.theme);
  const isBlossom = theme === "blossom";

  const handleOpenProject = async () => {
    try {
      const { openUrl } = await import("@tauri-apps/plugin-opener");
      await openUrl("https://github.com/lzlkyb/pastepanda");
    } catch (e) {
      console.warn("打开项目主页失败", e);
    }
  };

  return (
    <div className="dialog-body" style={{ "--dialog-body-padding": "28px 28px 24px" } as React.CSSProperties}>
      <div className={aboutStyles.aboutHero}>
        <div className={aboutStyles.aboutIcon}>
          {isBlossom ? (
            <img className={aboutStyles.aboutMelody} src={melodyUrl} alt="My Melody" draggable={false} />
          ) : (
            <AppIcon size={64} />
          )}
        </div>
        <div className={aboutStyles.aboutMeta}>
          <div className={aboutStyles.aboutName}>{appName}</div>
          <div className={aboutStyles.aboutVersionRow}>
            <VersionBadge version={appVersion} />
            <span className={`${aboutStyles.aboutVersionStatus} ${aboutStyles[versionStatus.cls]}`}>
              <span className={`${aboutStyles.aboutStatusDot} ${aboutStyles[versionStatus.dotCls]}`} />
              {versionStatus.label}
              {status === "error" && (
                <button
                  className={aboutStyles.aboutRetry}
                  onClick={() => void checkForUpdate()}
                  title="重新检查更新"
                >
                  重试
                </button>
              )}
            </span>
          </div>
        </div>
      </div>

      <div className={aboutStyles.aboutDivider} />

      <div className={aboutStyles.aboutSectionLabel}>技术栈</div>
      <div className={aboutStyles.aboutTechGrid}>
        {TECH_STACK.map((t) => (
          <div key={t.label} className={aboutStyles.aboutTechCard}>
            <div className={aboutStyles.aboutTechIcon} style={{ background: `${t.color}20`, color: t.color }}>
              {t.icon}
            </div>
            <div className={aboutStyles.aboutTechInfo}>
              <div className={aboutStyles.aboutTechName}>{t.label}</div>
              <div className={aboutStyles.aboutTechDesc}>{t.desc}</div>
            </div>
          </div>
        ))}
      </div>

      <UpdateBanner />

      <div className={aboutStyles.aboutDivider} />

      <div className={aboutStyles.aboutSectionLabel}>更新日志</div>
      <ChangelogView currentVersion={appVersion} maxEntries={10} />

      <div className={aboutStyles.aboutFooter}>
        <button className={aboutStyles.aboutFooterLink} onClick={handleOpenProject}>
          <ExternalLink size={14} />
          项目主页
        </button>
        <span className={aboutStyles.aboutCopyright}>© 2026 {appName}</span>
      </div>
    </div>
  );
}
