import { MobileNotice } from "../ui/MobileNotice";
import type { useMobileReceiveDir } from "./useMobileReceiveDir";
import ui from "../ui/MobileUi.module.css";

export function RcReceiveDirNotice({ directory }: { directory: ReturnType<typeof useMobileReceiveDir> }) {
  if (directory.error)
    return (
      <MobileNotice error title="文件接收位置不可用" detail={directory.error} action={<button
          type="button"
          className={ui.secondary}
          disabled={directory.busy}
          onClick={directory.canReset ? () => void directory.reset() : directory.retry}
        >
          {directory.busy ? "正在准备接收位置…" : directory.canReset ? "重置接收位置" : "重试"}
        </button>} />
    );
  if (directory.note) return <MobileNotice>{directory.note}</MobileNotice>;
  if (!directory.dir) return <MobileNotice tone="pending">正在获取文件接收位置…</MobileNotice>;
  return null;
}
