import type { RcFileView } from "@/hooks/useRcFile";
import { useMobileReceiveDir } from "../devices/useMobileReceiveDir";
import { RcReceiveDirNotice } from "../devices/RcReceiveDirNotice";
import { RcMobileFileAsks } from "../devices/RcMobileFileAsks";
import { rcErrorText } from "../devices/rcErrorText";
import { MobileNotice } from "../ui/MobileNotice";
import { MobileSheet } from "../ui/MobileSheet";
import ui from "../ui/MobileUi.module.css";

/** The file store stays application-owned; session controls expose its requests without ending video. */
export function SessionFileRequests({
  file,
  open,
  onClose,
}: {
  file: RcFileView;
  open: boolean;
  onClose: () => void;
}) {
  const directory = useMobileReceiveDir(open);
  const dir = directory.busy ? null : directory.dir;
  return (
    <>
      <MobileSheet
        open={open}
        title="文件请求"
        description="处理请求期间暂停远程输入，关闭后继续控制。"
        onClose={onClose}
      >
        {file.error && <MobileNotice error title="文件操作未能完成" detail={rcErrorText(file.error)} />}
        <RcReceiveDirNotice directory={directory} />
        {/* Keep this instance after the final request: its receipt stays visible
            until the user returns, and acceptance never means transfer finished. */}
        <RcMobileFileAsks file={file} receiveDir={dir} active={open} />
        {file.asks.length === 0 && <p className={ui.hint}>当前没有待确认的文件请求，可以返回远程画面。</p>}
        <button type="button" className={ui.secondary} onClick={onClose}>
          返回远程画面
        </button>
      </MobileSheet>
    </>
  );
}
