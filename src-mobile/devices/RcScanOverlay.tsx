/**
 * RcScanOverlay — 手机端「扫一扫」浮层（配对卡内）。
 *
 * 挂载即开扫：用户点「扫一扫」那一刻就是想扫，再要一次确认是多余的一步
 * （范式：高频路径一步到位）。取消只有一处——右上角「取消」，两级取消在这里
 * 只有一级，因为镜头开着本身就在告诉用户"我正在拍"。
 *
 * 失败三态都给一句人话 + 手动输入的路（`onClose` 回卡里就能敲码）：
 * 拒绝授权 / 没摄像头 / 起了流但取不到画面。没有摄像头权限的手机照样能配对，
 * 这条 fallback 不是摆设。
 */
import { useEffect } from "react";
import { X } from "lucide-react";
import { useQrScan } from "./useQrScan";
import styles from "./RcDevices.module.css";

export function RcScanOverlay({
  onFound,
  onClose,
}: {
  onFound: (text: string) => void;
  onClose: () => void;
}) {
  const scan = useQrScan(onFound);
  useEffect(() => {
    void scan.start();
    // 挂载一次就够；scan.start 引用稳定（依赖仅 onFound/stop）
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hint =
    scan.state === "starting"
      ? "正在打开摄像头…"
      : scan.state === "denied"
        ? "没有摄像头权限。可以在系统设置里给 PastePanda 开权限，或者返回手动输入那串码。"
        : scan.state === "unavailable"
          ? "这台设备取不到摄像头画面，请返回手动输入那串码。"
          : "把对方的配对码放进取景框";

  return (
    <div className={styles.scanOverlay}>
      <div className={styles.scanHead}>
        <span className={styles.scanTitle}>扫一扫</span>
        <button type="button" className={styles.ghostBtn} onClick={onClose} aria-label="取消扫描">
          <X size={16} />
        </button>
      </div>
      <video
        ref={scan.videoRef}
        className={styles.scanVideo}
        muted
        playsInline
        aria-label="摄像头取景"
      />
      <div className={styles.scanHint}>{hint}</div>
      <button type="button" className={styles.ghostBtn} onClick={onClose}>
        取消，手动输入
      </button>
    </div>
  );
}
