import { useState } from "react";
import { MobileNotice } from "./MobileNotice";
import { MobileFeedbackSlot } from "./MobileFeedbackSlot";
import { MobileUpdateSheet } from "./MobileUpdateSheet";
import { progressText, useMobileUpdate } from "./MobileUpdate";
import ui from "./MobileUi.module.css";

export function MobileUpdateBanner({ quiet = false }: { quiet?: boolean }) {
  const update = useMobileUpdate();
  const [open, setOpen] = useState(false);
  const { status, info, progress } = update;
  const action = (label: string) => (
    <button className={ui.textButton} onClick={() => setOpen(true)}>
      {label}
    </button>
  );

  let notice = null;
  if (status === "available") {
    notice = (
      <MobileNotice variant="banner" title={`发现新版本 v${info?.version ?? ""}`} onDismiss={update.dismiss} action={action("更新")} />
    );
  } else if (status === "downloading") {
    notice = <MobileNotice variant="banner" tone="pending" title={progressText(progress)} action={action("查看")} />;
  } else if (status === "ready") {
    notice = (
      <MobileNotice variant="banner" tone="success" title="已下载完成，点此打开安装器" onDismiss={update.dismiss} action={action("安装")} />
    );
  } else if (status === "needPermission") {
    notice = (
      <MobileNotice variant="banner" tone="warning" title="需要允许 PastePanda 安装应用" detail="授权后返回本页自动继续，无需重新下载" action={action("去授权")} />
    );
  }

  return (
    <>
      {/* Update failures remain recoverable in Settings and the initiating sheet. */}
      <MobileFeedbackSlot>{!quiet ? notice : null}</MobileFeedbackSlot>
      <MobileUpdateSheet open={open} onClose={() => setOpen(false)} />
    </>
  );
}
