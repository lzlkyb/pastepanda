import type { RcCodec, RcCodecChoice as CodecChoice } from "@/hooks/useRcCodecChoice";
import { RcDropdown } from "./RcDropdown";
import styles from "./RemoteComputer.module.css";

export function RcCodecChoice({ choice }: { choice: CodecChoice }) {
  return (
    <>
      <div className={styles.capMoreSec}>视频编码</div>
      <div className={styles.capMoreBtns}>
        <RcDropdown label="编码" value={choice.value} options={choice.options}
          disabled={choice.disabled} disabledTitle={choice.pending ? "正在切换编码" : "链路未连通，暂不能切换编码"}
          onPick={codec => void choice.pick(codec as RcCodec)} />
      </div>
      <div className={styles.capCodecStatus} role="status" aria-live="polite">
        {choice.pending ? "正在切换 · " : ""}实际接收：{choice.actualLabel}
      </div>
      {choice.mac && choice.value === "av1" && (
        <div className={styles.capCodecStatus}>软件接收最高 1080p；超限或解码失败会尝试 H.264</div>
      )}
    </>
  );
}
