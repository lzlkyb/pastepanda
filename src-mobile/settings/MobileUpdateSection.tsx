import { useEffect, useRef, useState } from "react";
import { ChevronRight, RefreshCw, Smartphone, UploadCloud } from "lucide-react";
import { MobileUpdateSheet } from "../ui/MobileUpdateSheet";
import { progressText, useMobileUpdate, type MobileUpdateStatus } from "../ui/MobileUpdate";
import ui from "../ui/MobileUi.module.css";
import styles from "./RcSettings.module.css";

type Row = { strong: string; small: string; action: string };

function statusRow(status: MobileUpdateStatus, version: string, installed: string, prog: string): Row | null {
  switch (status) {
    case "available":
      return { strong: `发现新版本 v${version}`, small: "查看更新内容并下载", action: "查看" };
    case "downloading":
      return { strong: `正在下载 v${version}`, small: prog, action: "进度" };
    case "ready":
      return { strong: "已下载，等待安装", small: "打开系统安装器完成覆盖安装", action: "安装" };
    case "needPermission":
      return { strong: "需要安装权限", small: "点此继续授权流程", action: "授权" };
    case "error":
      return { strong: "更新未完成", small: "点此查看详情并重试", action: "重试" };
    case "uptodate":
      return { strong: "已是最新版本", small: `当前 v${installed || "最新"}`, action: "详情" };
    default:
      return null;
  }
}

export function MobileUpdateSection() {
  const update = useMobileUpdate();
  const { status, info, installed, progress, busy } = update;
  const [open, setOpen] = useState(false);
  // 手动检查命中新版本时自动展开半屏；24h 静默自检不抢焦点（那时由横幅提示）。
  // 标志必须在任一终态收口，否则检查失败/已最新后残留的 true 会让下一次后台自检凭空弹屏。
  const manualCheck = useRef(false);

  useEffect(() => {
    if (!manualCheck.current) return;
    if (status === "available") {
      manualCheck.current = false;
      setOpen(true);
    } else if (status === "error" || status === "uptodate") {
      manualCheck.current = false;
    }
  }, [status]);

  const row = statusRow(status, info?.version ?? "", installed, progressText(progress));
  const checkHint =
    status === "checking" ? "正在检查…" : status === "uptodate" ? "已是最新版本" : "点击检查是否有新版本";

  return (
    <>
      <h2 className={ui.sectionHeading}>关于与更新</h2>
      <div className={ui.group}>
        <div className={styles.row}>
          <Smartphone size={22} aria-hidden="true" />
          <span className={styles.rowText}>
            <strong>当前版本</strong>
            <small>{installed ? `v${installed}` : "版本读取中…"}</small>
          </span>
        </div>

        {row && (
          <button type="button" className={styles.row} onClick={() => setOpen(true)}>
            <UploadCloud size={22} aria-hidden="true" />
            <span className={styles.rowText}>
              <strong>{row.strong}</strong>
              <small>{row.small}</small>
            </span>
            <span className={ui.textButton}>
              {row.action}
              <ChevronRight size={16} aria-hidden="true" />
            </span>
          </button>
        )}

        <button
          type="button"
          className={styles.row}
          disabled={busy || status === "checking"}
          onClick={() => {
            manualCheck.current = true;
            void update.checkNow();
          }}
        >
          <RefreshCw size={22} aria-hidden="true" />
          <span className={styles.rowText}>
            <strong>检查更新</strong>
            <small>{checkHint}</small>
          </span>
        </button>
      </div>

      <MobileUpdateSheet open={open} onClose={() => setOpen(false)} />
    </>
  );
}
