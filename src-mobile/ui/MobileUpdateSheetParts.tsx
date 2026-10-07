import { Download, RefreshCw, ShieldCheck, TriangleAlert, UploadCloud } from "lucide-react";
import { progressText, type MobileUpdate, type MobileUpdateStatus } from "./MobileUpdate";
import styles from "./MobileUpdateSheet.module.css";
import ui from "./MobileUi.module.css";

/** 半屏标题随状态机变化。 */
export function sheetTitle(status: MobileUpdateStatus, target: string): string {
  switch (status) {
    case "available":
      return `发现新版本${target ? ` v${target}` : ""}`;
    case "downloading":
      return `正在下载${target ? ` v${target}` : ""}`;
    case "ready":
      return "准备安装";
    case "needPermission":
      return "需要授权";
    case "error":
      return "更新未完成";
    case "checking":
      return "检查更新";
    default:
      return "关于与更新";
  }
}

/** 非 available 的状态视图（下载中 / 待安装 / 待授权 / 出错 / 检查中或已最新）。 */
export function UpdateStatusBody({ update }: { update: MobileUpdate }) {
  const { status, info, installed, progress, error, installAllowed } = update;
  const target = info?.version ?? "";
  if (status === "downloading") {
    return (
      <div className={styles.state}>
        <div className={styles.stateIco}>
          <Download size={26} aria-hidden="true" />
        </div>
        <h3 className={styles.stateH}>正在下载 v{target}</h3>
        <p className={styles.stateP}>收起半屏也不会中断下载，进度会保留在这里。</p>
        <progress className={styles.progress} value={progress?.total ? progress.downloaded : undefined} max={progress?.total ?? undefined} />
        <div className={styles.progressNum}>
          <span>{progressText(progress)}</span>
          {progress?.total ? <span>{Math.min(Math.round((progress.downloaded / progress.total) * 100), 100)}%</span> : null}
        </div>
      </div>
    );
  }
  if (status === "ready") {
    return (
      <div className={styles.state}>
        <div className={styles.stateIco}>
          <ShieldCheck size={26} aria-hidden="true" />
        </div>
        <h3 className={styles.stateH}>下载完成，准备安装</h3>
        <p className={styles.stateP}>安装包已校验通过。点下方按钮打开系统安装器，在系统弹窗里点「继续 / 安装」即可完成覆盖安装，本地数据与配对都会保留。</p>
        <div className={styles.sysNote}>
          <TriangleAlert size={16} aria-hidden="true" />
          <span>Android 出于安全不允许应用静默安装——这一步的系统确认无法跳过，属正常流程。</span>
        </div>
      </div>
    );
  }
  if (status === "needPermission") {
    return (
      <div className={styles.state}>
        <div className={styles.stateIco} data-tone="warning">
          <ShieldCheck size={26} aria-hidden="true" />
        </div>
        <h3 className={styles.stateH}>需要「安装未知应用」权限</h3>
        <p className={styles.stateP}>
          {installAllowed
            ? "权限已授予，点此继续安装（安装包已缓存）。"
            : "首次更新需允许 PastePanda 安装应用。授权后回到本页会自动继续，无需重新下载。"}
        </p>
        <div className={styles.sysNote}>
          <ShieldCheck size={16} aria-hidden="true" />
          <span>授权只放行系统安装器，不会重复消耗流量。</span>
        </div>
      </div>
    );
  }
  if (status === "error") {
    return (
      <div className={styles.state}>
        <div className={styles.stateIco} data-tone="error">
          <TriangleAlert size={26} aria-hidden="true" />
        </div>
        <h3 className={styles.stateH}>更新没能完成</h3>
        <p className={styles.stateP}>{error || "请检查连接状态后重试。"}</p>
        <div className={styles.sysNote}>
          <RefreshCw size={16} aria-hidden="true" />
          <span>已下载的部分会保留，重试从断点继续，不重复消耗流量。</span>
        </div>
      </div>
    );
  }
  // checking / uptodate / idle
  return (
    <div className={styles.state}>
      <div className={styles.stateIco}>
        <RefreshCw size={26} aria-hidden="true" />
      </div>
      <h3 className={styles.stateH}>
        {status === "checking" ? "正在检查更新…" : `已是最新版本${installed ? ` v${installed}` : ""}`}
      </h3>
      <p className={styles.stateP}>
        {status === "checking"
          ? "正在连接更新源，请稍候。"
          : "有新版本时这里和顶部横幅都会提示你，也可以立即再查一次。"}
      </p>
    </div>
  );
}

/** 页脚操作行：主按钮随状态机切换触发点（下载 / 打开安装器 / 授权 / 重试 / 检查）。 */
export function UpdateFooter({ update, onClose }: { update: MobileUpdate; onClose: () => void }) {
  const { status, busy, info, installAllowed } = update;
  const skip = (
    <button type="button" className={ui.secondary} onClick={onClose}>
      稍后
    </button>
  );

  if (status === "available") {
    return (
      <>
        {skip}
        <button type="button" className={ui.primary} disabled={busy} onClick={() => void update.startUpdate()}>
          <Download size={18} aria-hidden="true" />
          下载并更新
        </button>
      </>
    );
  }
  if (status === "downloading") {
    return (
      <button type="button" className={ui.primary} disabled>
        <Download size={18} aria-hidden="true" />
        下载中…
      </button>
    );
  }
  if (status === "ready") {
    return (
      <button type="button" className={ui.primary} onClick={() => void update.startUpdate()}>
        <UploadCloud size={18} aria-hidden="true" />
        打开安装器
      </button>
    );
  }
  if (status === "needPermission") {
    return (
      <button
        type="button"
        className={ui.primary}
        onClick={() => void (installAllowed ? update.startUpdate() : update.openInstallSettings())}
      >
        <ShieldCheck size={18} aria-hidden="true" />
        {installAllowed ? "继续安装" : "去授权"}
      </button>
    );
  }
  if (status === "error") {
    return (
      <button type="button" className={ui.primary} disabled={busy} onClick={() => void (info ? update.startUpdate() : update.checkNow())}>
        <RefreshCw size={18} aria-hidden="true" />
        {info ? "重试下载" : "重新检查"}
      </button>
    );
  }
  if (status === "checking") {
    return (
      <button type="button" className={ui.primary} disabled>
        <RefreshCw size={18} aria-hidden="true" />
        检查中…
      </button>
    );
  }
  return (
    <>
      {skip}
      <button type="button" className={ui.primary} disabled={busy} onClick={() => void update.checkNow()}>
        <RefreshCw size={18} aria-hidden="true" />
        立即检查
      </button>
    </>
  );
}
