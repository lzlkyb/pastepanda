import { useState } from "react";
import { motion, AnimatePresence } from "framer-motion";
import { useUpdate, friendlyError } from "@/contexts/UpdateContext";
import { ArrowDown, Loader2, CheckCircle, AlertCircle, RotateCcw } from "lucide-react";
import { VersionBadge } from "@/components/VersionBadge";
import styles from "./UpdateBanner.module.css";

/** 下载速率格式化（如 "1.2 MB/s"） */
function formatBytesPerSec(bytesPerSec: number): string {
  if (bytesPerSec <= 0) return "";
  if (bytesPerSec < 1024) return `${bytesPerSec} B/s`;
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
}

/** Header 下载进度环：14px SVG 圆环，确定态显示百分比弧，不确定态整体旋转 */
function DownloadRing({ progress, indeterminate }: { progress: number; indeterminate: boolean }) {
  const size = 14;
  const stroke = 2.5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.min(100, Math.max(0, progress));
  const offset = indeterminate ? c * 0.75 : c * (1 - clamped / 100);
  return (
    <svg
      width={size} height={size} viewBox={`0 0 ${size} ${size}`}
      className={indeterminate ? "spin-icon" : ""}
      aria-hidden="true"
    >
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth={stroke} />
      <circle
        cx={size / 2} cy={size / 2} r={r} fill="none"
        stroke="#fff" strokeWidth={stroke} strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={offset}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

/**
 * TopBar 版本号融合徽章
 * 方案 D：更新状态融入 header-badge 本身，不再单独占用布局空间
 *
 * - idle/checking/error：普通灰色标签 [v5.0.70]
 * - available：绿色可点击 [🔄 v5.0.71] 点击下载
 * - downloading：[⏳ 45%]
 * - ready/installed：[✅ 重启]
 *
 * 使用 AnimatePresence + key 实现状态切换进出动画。
 */
export function UpdateBadge({ currentVersion }: { currentVersion: string }) {
  const { status, update, progress, progressIndeterminate, bytesPerSec, checkForUpdate, downloadAndInstall, restart } = useUpdate();
  // 防止用户快速重复点击（连点更新徽章）导致重复触发检查/下载/重启
  const [isStarting, setIsStarting] = useState(false);

  const handleClick = async () => {
    if (isStarting) return;
    setIsStarting(true);
    try {
      if (status === "idle" || status === "error") {
        await checkForUpdate();
      } else if (status === "available") {
        await downloadAndInstall();
      } else if (status === "ready" || status === "installed") {
        await restart();
      }
    } finally {
      setIsStarting(false);
    }
  };

  return (
    <AnimatePresence mode="wait">
      {/* 有新版本：替换版本号，显示可点击的绿色更新按钮 */}
      {status === "available" && (() => {
        const ver = update?.version ?? "";
        return (
          <motion.button
            key="update-available"
            initial={{ scale: 0.8, opacity: 0 }}
            animate={{ scale: 1, opacity: 1 }}
            exit={{ scale: 0.8, opacity: 0 }}
            className="header-badge header-badge-update"
            title={`发现新版本 v${ver}，点击下载更新`}
            onClick={handleClick}
            disabled={isStarting}
          >
            <ArrowDown size={10} />
            <span>更新 v{ver}</span>
          </motion.button>
        );
      })()}

      {/* 下载中：DownloadRing 圆环 + 百分比（确定态）/ "下载中"（不确定态） + 速率 */}
      {status === "downloading" && (() => {
        const speedText = bytesPerSec > 0 ? ` · ${formatBytesPerSec(bytesPerSec)}` : "";
        const titleText = `正在下载更新…${speedText}`;
        return (
          <motion.span
            key="update-downloading"
            initial={{ opacity: 0 }}
            animate={{ opacity: 1 }}
            exit={{ opacity: 0 }}
            className="header-badge header-badge-downloading"
            title={titleText}
          >
            <DownloadRing progress={progress} indeterminate={progressIndeterminate} />
            <span>{progressIndeterminate ? `下载中${speedText}` : `下载中 ${progress}%${speedText}`}</span>
          </motion.span>
        );
      })()}

      {/* 已就绪/已安装 */}
      {(status === "ready" || status === "installed") && (
        <motion.button
          key="update-ready"
          initial={{ scale: 0.8, opacity: 0 }}
          animate={{ scale: 1, opacity: 1 }}
          exit={{ scale: 0.8, opacity: 0 }}
          className="header-badge header-badge-ready"
          title="更新已安装，点击重启"
          onClick={handleClick}
          disabled={isStarting}
        >
          <RotateCcw size={10} />
          <span>重启</span>
        </motion.button>
      )}

      {/* 已是最新版本（4 秒后自动消失回到 idle） */}
      {status === "uptodate" && (
        <motion.span
          key="update-uptodate"
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 4 }}
          className="header-badge header-badge-uptodate"
          title="已是最新版本"
        >
          <CheckCircle size={10} />
          <span>已是最新</span>
        </motion.span>
      )}

      {/* 检查中：独立徽章，带旋转图标 */}
      {status === "checking" && (
        <motion.span
          key="update-checking"
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 4 }}
          className="header-badge header-badge-checking"
          title="检查更新中…"
        >
          <Loader2 size={10} className="spin-icon" />
          <span>{currentVersion}</span>
        </motion.span>
      )}

      {/* 错误：独立徽章，红色，可点击重试 */}
      {status === "error" && (
        <motion.button
          key="update-error"
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 4 }}
          className="header-badge header-badge-error"
          title="更新检查失败，点击重试"
          onClick={handleClick}
          disabled={isStarting}
        >
          <AlertCircle size={10} />
          <span>{currentVersion}</span>
        </motion.button>
      )}

      {/* idle：默认版本号，可点击检查更新 */}
      {status === "idle" && (
        <motion.span
          key="update-idle"
          initial={{ opacity: 0, y: -4 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: 4 }}
          className="version-badge-wrapper"
          title={`v${currentVersion} — 点击检查更新`}
        >
          <button
            className="version-badge-btn"
            title={`v${currentVersion} — 点击检查更新`}
            onClick={handleClick}
            disabled={isStarting}
          >
            <VersionBadge version={currentVersion} className="version-badge-idle" />
          </button>
        </motion.span>
      )}
    </AnimatePresence>
  );
}

/** AboutDialog 中使用的更新横幅 + 下载进度 */
export function UpdateBanner() {
  const { status, update, progress, progressIndeterminate, bytesPerSec, error, checkForUpdate, downloadAndInstall, restart, markInstalled, skipThisVersion } =
    useUpdate();

  const bannerKey = `banner-${status}`;

  return (
    <AnimatePresence mode="wait">
      {status === "checking" && (
        <motion.div
          key={bannerKey}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.2 }}
          className={`${styles.updateBanner} ${styles.updateBannerChecking}`}
        >
          <Loader2 size={14} className="spin-icon" />
          <div>
            <div className={styles.updateBannerTitle}>检查更新中…</div>
          </div>
        </motion.div>
      )}

      {status === "available" && (() => {
        const ver = update?.version ?? "";
        const desc = update?.body || "包含性能优化和 bug 修复";
        return (
          <motion.div
            key={bannerKey}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.2 }}
            className={`${styles.updateBanner} ${styles.updateBannerAvailable}`}
          >
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
            <button
              className={`${styles.updateBannerBtn} ${styles.updateBannerBtnSkip}`}
              onClick={skipThisVersion}
              title="不再提示此版本"
            >
              跳过
            </button>
          </motion.div>
        );
      })()}

      {status === "downloading" && (() => {
        const speedText = bytesPerSec > 0 ? ` · ${formatBytesPerSec(bytesPerSec)}` : "";
        return (
          <motion.div
            key={bannerKey}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.2 }}
            className={`${styles.updateBanner} ${styles.updateBannerDownloading}`}
          >
            <Loader2 size={14} className="spin-icon" />
            <div style={{ flex: 1 }}>
              <div className={styles.updateBannerTitle}>
                {progressIndeterminate ? "正在下载更新…" : `正在下载更新… ${progress}%`}
                <span className={styles.updateBannerSpeed}>{speedText}</span>
              </div>
              <div className={styles.updateProgressBar}>
                <div
                  className={styles.updateProgressFill}
                  style={progressIndeterminate
                    ? { width: "40%", animation: "progress-indeterminate 1.5s ease-in-out infinite" }
                    : { width: `${progress}%`, transition: "width 0.4s ease" }
                  }
                />
              </div>
              <div className={styles.updateBannerDesc}>正在从 GitHub 下载，请耐心等待</div>
            </div>
          </motion.div>
        );
      })()}

      {status === "ready" && (
        <motion.div
          key={bannerKey}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.2 }}
          className={`${styles.updateBanner} ${styles.updateBannerReady}`}
        >
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
        </motion.div>
      )}

      {status === "installed" && (
        <motion.div
          key={bannerKey}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.2 }}
          className={`${styles.updateBanner} ${styles.updateBannerReady}`}
        >
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
        </motion.div>
      )}

      {status === "error" && (() => {
        const fe = error ? friendlyError(error) : null;
        return (
          <motion.div
            key={bannerKey}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.2 }}
            className={`${styles.updateBanner} ${styles.updateBannerError}`}
          >
            <AlertCircle size={16} style={{ color: "var(--danger)", flexShrink: 0, marginTop: 2 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className={styles.updateBannerTitle}>更新失败</div>
              <div className={styles.updateBannerDesc}>{fe?.friendly || "未知错误，请重试"}</div>
              {fe?.raw && (
                <div className={styles.updateBannerRaw}>{fe.raw}</div>
              )}
            </div>
            <button className={styles.updateBannerBtn} onClick={checkForUpdate}>
              重试
            </button>
          </motion.div>
        );
      })()}

      {(status === "idle" || status === "uptodate") && (
        <motion.div
          key={bannerKey}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.2 }}
          className={`${styles.updateBanner} ${styles.updateBannerIdle}`}
        >
          <CheckCircle size={14} style={{ color: "var(--accent)" }} />
          <div style={{ flex: 1 }}>
            <div className={styles.updateBannerTitle}>已是最新版本</div>
          </div>
          <button className={styles.updateBannerBtn} onClick={checkForUpdate}>
            检查更新
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
