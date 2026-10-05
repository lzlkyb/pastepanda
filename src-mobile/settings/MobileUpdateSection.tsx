import { Download, RefreshCw, ShieldCheck, Smartphone, UploadCloud } from "lucide-react";
import { progressText, useMobileUpdate } from "../ui/MobileUpdate";
import { MobileNotice } from "../ui/MobileNotice";
import ui from "../ui/MobileUi.module.css";
import upStyles from "../ui/MobileUpdate.module.css";
import styles from "./RcSettings.module.css";

function firstLine(body: string | null | undefined): string {
  const line = (body ?? "")
    .split(/\r?\n/)
    .map((l) => l.replace(/^[-*]\s+/, "").trim())
    .find(Boolean);
  return line ?? "";
}

export function MobileUpdateSection() {
  const update = useMobileUpdate();
  const { status, info, installed, progress, error, installAllowed } = update;
  const versionLine = installed ? `v${installed}` : "版本读取中…";

  if (status === "downloading") {
    return (
      <>
        <h2 className={ui.sectionHeading}>关于与更新</h2>
        <div className={ui.group}>
          <div className={styles.row}>
            <Download size={22} aria-hidden="true" />
            <span className={upStyles.rowStack}>
              <strong>正在下载 v{info?.version ?? ""}</strong>
              <small>{progressText(progress)}</small>
              <progress
                className={upStyles.progress}
                value={progress?.total ? progress.downloaded : undefined}
                max={progress?.total ?? undefined}
                aria-label="更新下载进度"
              />
            </span>
          </div>
        </div>
      </>
    );
  }

  if (status === "available") {
    return (
      <>
        <h2 className={ui.sectionHeading}>关于与更新</h2>
        <div className={ui.group}>
          <button type="button" className={styles.row} onClick={() => void update.startUpdate()}>
            <UploadCloud size={22} aria-hidden="true" />
            <span className={styles.rowText}>
              <strong>发现新版本 v{info?.version}</strong>
              <small>{firstLine(info?.body) || "点击下载并安装"}</small>
            </span>
            <span className={ui.textButton}>更新</span>
          </button>
        </div>
      </>
    );
  }

  if (status === "ready") {
    return (
      <>
        <h2 className={ui.sectionHeading}>关于与更新</h2>
        <div className={ui.group}>
          <button type="button" className={styles.row} onClick={() => void update.startUpdate()}>
            <ShieldCheck size={22} aria-hidden="true" />
            <span className={styles.rowText}>
              <strong>安装程序已拉起</strong>
              <small>在系统弹窗中确认安装；被系统拦截时可点此重新打开（安装包已缓存）</small>
            </span>
            <span className={ui.textButton}>重试</span>
          </button>
        </div>
      </>
    );
  }

  if (status === "needPermission") {
    return (
      <>
        <h2 className={ui.sectionHeading}>关于与更新</h2>
        <div className={ui.group}>
          <button
            type="button"
            className={styles.row}
            onClick={() => (installAllowed ? void update.startUpdate() : void update.openInstallSettings())}
          >
            <ShieldCheck size={22} aria-hidden="true" />
            <span className={styles.rowText}>
              <strong>需要「安装未知应用」权限</strong>
              <small>
                {installAllowed
                  ? "权限已授予，点此继续安装（安装包已缓存）"
                  : "同意后回到本页即可继续，无需重新下载"}
              </small>
            </span>
            <span className={ui.textButton}>{installAllowed ? "继续安装" : "去授权"}</span>
          </button>
          {error && <MobileNotice error title="未能打开授权页" detail={error} onDismiss={update.clearError} />}
        </div>
      </>
    );
  }

  const hint =
    status === "checking"
      ? "正在检查…"
      : status === "uptodate"
        ? "已是最新版本"
        : status === "error"
          ? "未能完成，请在下方重试"
          : "点击检查是否有新版本";
  return (
    <>
      <h2 className={ui.sectionHeading}>关于与更新</h2>
      <div className={ui.group}>
        <div className={styles.row}>
          <Smartphone size={22} aria-hidden="true" />
          <span className={styles.rowText}>
            <strong>当前版本</strong>
            <small>{versionLine}</small>
          </span>
        </div>
        <button
          type="button"
          className={styles.row}
          disabled={update.busy || status === "checking"}
          onClick={() => void update.checkNow()}
        >
          <RefreshCw size={22} aria-hidden="true" />
          <span className={styles.rowText}>
            <strong>检查更新</strong>
            <small>{hint}</small>
          </span>
          {status === "error" && <span className={ui.textButton}>重试</span>}
        </button>
      </div>
      {status === "error" && <MobileNotice error title="更新操作未能完成" detail={error ?? "请检查连接状态后重试。"} onDismiss={update.dismiss}
        action={<button type="button" className={ui.textButton} disabled={update.busy} onClick={() => void update.checkNow()}>重新检查</button>} />}
    </>
  );
}
