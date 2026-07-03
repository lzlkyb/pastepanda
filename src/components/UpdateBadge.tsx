import { motion } from "framer-motion";
import { useUpdate } from "@/contexts/UpdateContext";
import { ArrowDown, Loader2, CheckCircle, AlertCircle, RotateCcw } from "lucide-react";
import { VersionBadge } from "@/components/VersionBadge";
import styles from "./UpdateBanner.module.css";

/**
 * TopBar 版本号融合徽章
 * 方案 D：更新状态融入 header-badge 本身，不再单独占用布局空间
 *
 * - idle/checking/error：普通灰色标签 [v5.0.70]
 * - available：绿色可点击 [🔄 v5.0.71] 点击下载
 * - downloading：[⏳ 45%]
 * - ready/installed：[✅ 重启]
 */
export function UpdateBadge({ currentVersion }: { currentVersion: string }) {
  const { status, update, progress, downloadAndInstall, restart } = useUpdate();

  const handleClick = async () => {
    if (status === "available") {
      await downloadAndInstall();
    } else if (status === "ready" || status === "installed") {
      await restart();
    }
  };

  // 有新版本：替换版本号，显示可点击的绿色更新按钮
  if (status === "available") {
    const ver = update?.version ?? "";
    return (
      <motion.button
        key="update-available"
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        className="header-badge header-badge-update"
        title={`发现新版本 v${ver}，点击下载更新`}
        onClick={handleClick}
      >
        <ArrowDown size={10} />
        <span>更新 v{ver}</span>
      </motion.button>
    );
  }

  // 下载中（不确定进度条，因为 GitHub Release 重定向不返回 Content-Length）
  if (status === "downloading") {
    return (
      <motion.span
        key="update-downloading"
        initial={{ opacity: 0 }}
        animate={{ opacity: 1 }}
        className="header-badge header-badge-downloading"
        title="正在下载更新…"
      >
        <Loader2 size={10} className="spin-icon" />
        <span>下载中</span>
      </motion.span>
    );
  }

  // 已就绪/已安装
  if (status === "ready" || status === "installed") {
    return (
      <motion.button
        key="update-ready"
        initial={{ scale: 0.8, opacity: 0 }}
        animate={{ scale: 1, opacity: 1 }}
        className="header-badge header-badge-ready"
        title="更新已安装，点击重启"
        onClick={handleClick}
      >
        <RotateCcw size={10} />
        <span>重启</span>
      </motion.button>
    );
  }

  // idle / checking / error：显示不同状态的版本徽章
  const idleTitle =
    status === "checking" ? "检查更新中…" :
    status === "error" ? "更新检查失败" :
    `v${currentVersion}`;

  const badgeClass =
    status === "checking" ? "version-badge-checking" :
    status === "error" ? "version-badge-error" :
    "version-badge-idle";

  return (
    <span className="version-badge-wrapper" title={idleTitle}>
      {status === "checking" && <Loader2 size={10} className="spin-icon version-badge-spin" />}
      {status === "error" && <AlertCircle size={10} className="version-badge-error-icon" />}
      <VersionBadge version={currentVersion} className={badgeClass} />
    </span>
  );
}

/** AboutDialog 中使用的更新横幅 + 下载进度 */
export function UpdateBanner() {
  const { status, update, progress, error, checkForUpdate, downloadAndInstall, restart, markInstalled } =
    useUpdate();

  switch (status) {
    case "checking":
      return (
        <div className={`${styles.updateBanner} ${styles.updateBannerChecking}`}>
          <Loader2 size={14} className="spin-icon" />
          <div>
            <div className={styles.updateBannerTitle}>检查更新中…</div>
          </div>
        </div>
      );

    case "available": {
      const ver = update?.version ?? "";
      const desc = update?.body || "包含性能优化和 bug 修复";
      return (
        <div className={`${styles.updateBanner} ${styles.updateBannerAvailable}`}>
          <div className={styles.updateBannerIcon}>
            <ArrowDown size={16} />
          </div>
          <div style={{ flex: 1 }}>
            <div className={styles.updateBannerTitle}>发现新版本 v{ver}</div>
            <div className={styles.updateBannerDesc}>{desc}</div>
          </div>
          <button className={styles.updateBannerBtn} onClick={downloadAndInstall}>
            <ArrowDown size={12} /> 下载更新
          </button>
        </div>
      );
    }

    case "downloading":
      return (
        <div className={`${styles.updateBanner} ${styles.updateBannerDownloading}`}>
          <Loader2 size={14} className="spin-icon" />
          <div style={{ flex: 1 }}>
            <div className={styles.updateBannerTitle}>正在下载更新…</div>
            <div className={styles.updateProgressBar}>
              <div className={`${styles.updateProgressFill} ${styles.updateProgressIndeterminate}`} />
            </div>
            <div className={styles.updateBannerDesc}>正在从 GitHub 下载，请耐心等待</div>
          </div>
        </div>
      );

    case "ready":
      return (
        <div className={`${styles.updateBanner} ${styles.updateBannerReady}`}>
          <CheckCircle size={16} style={{ color: "var(--accent)" }} />
          <div style={{ flex: 1 }}>
            <div className={styles.updateBannerTitle}>更新已下载完成</div>
            <div className={styles.updateBannerDesc}>点击重启以应用更新</div>
          </div>
          <button
            className={`${styles.updateBannerBtn} ${styles.updateBannerBtnRestart}`}
            onClick={async () => {
              markInstalled();
              await restart();
            }}
          >
            <RotateCcw size={12} /> 立即重启
          </button>
        </div>
      );

    case "installed":
      return (
        <div className={`${styles.updateBanner} ${styles.updateBannerReady}`}>
          <CheckCircle size={16} style={{ color: "var(--accent)" }} />
          <div style={{ flex: 1 }}>
            <div className={styles.updateBannerTitle}>更新已安装</div>
            <div className={styles.updateBannerDesc}>需要重启应用才能生效</div>
          </div>
          <button
            className={`${styles.updateBannerBtn} ${styles.updateBannerBtnRestart}`}
            onClick={restart}
          >
            <RotateCcw size={12} /> 立即重启
          </button>
        </div>
      );

    case "error":
      return (
        <div className={`${styles.updateBanner} ${styles.updateBannerError}`}>
          <AlertCircle size={16} style={{ color: "var(--danger)" }} />
          <div style={{ flex: 1 }}>
            <div className={styles.updateBannerTitle}>更新失败</div>
            <div className={styles.updateBannerDesc}>{error || "未知错误，请重试"}</div>
          </div>
          <button className={styles.updateBannerBtn} onClick={checkForUpdate}>
            重试
          </button>
        </div>
      );

    case "idle":
    default:
      return (
        <div className={`${styles.updateBanner} ${styles.updateBannerIdle}`}>
          <CheckCircle size={14} style={{ color: "var(--accent)" }} />
          <div style={{ flex: 1 }}>
            <div className={styles.updateBannerTitle}>已是最新版本</div>
          </div>
          <button className={styles.updateBannerBtn} onClick={checkForUpdate}>
            检查更新
          </button>
        </div>
      );
  }
}
