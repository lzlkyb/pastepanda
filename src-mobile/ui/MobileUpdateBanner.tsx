import { MobileNotice } from "./MobileNotice";
import { progressText, useMobileUpdate } from "./MobileUpdate";
import ui from "./MobileUi.module.css";

export function MobileUpdateBanner() {
  const update = useMobileUpdate();
  const { status, info, progress } = update;
  if (status === "available") {
    return (
      <MobileNotice
        variant="banner"
        title={`发现新版本 v${info?.version ?? ""}`}
        onDismiss={update.dismiss}
        action={
          <button className={ui.textButton} onClick={() => void update.startUpdate()}>
            更新
          </button>
        }
      />
    );
  }
  if (status === "downloading") {
    return <MobileNotice variant="banner" tone="pending" title={progressText(progress)} />;
  }
  if (status === "ready") {
    return (
      <MobileNotice
        variant="banner"
        tone="success"
        title="安装程序已拉起，请在系统弹窗中确认"
        onDismiss={update.dismiss}
      />
    );
  }
  if (status === "needPermission") {
    return (
      <MobileNotice
        variant="banner"
        tone="warning"
        title="需要允许 PastePanda 安装应用"
        detail="同意后回到本页会自动继续，无需重新下载"
        action={
          <button className={ui.textButton} onClick={() => void update.openInstallSettings()}>
            去授权
          </button>
        }
      />
    );
  }
  if (status === "error") {
    return (
      <MobileNotice
        variant="banner"
        error
        title="更新失败"
        detail={update.error ?? undefined}
        onDismiss={update.dismiss}
        action={
          <button className={ui.textButton} onClick={() => void update.startUpdate()}>
            重试
          </button>
        }
      />
    );
  }
  return null;
}
