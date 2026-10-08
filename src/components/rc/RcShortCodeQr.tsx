/**
 * RcShortCodeQr — 8 位会合码的二维码（`PP-XXXX-XXXX`，lib/rcShortCode 收口）。
 *
 * 桌面出示侧的「可扫形态」：手机「扫一扫」扫的就是它（2026-10-01 联调补上——
 * 此前二维码只在手机出示态有，电脑上只有明文，手机举着相机没东西可扫）。
 * 大字明文码始终是主形态，二维码是附在下面的省事形态。
 *
 * 出码本身交给 `QrCanvas`（全仓二维码唯一出口）；这里只负责把会合码转成码载荷。
 * 画不出来（canvas 不可用等）不弹不闹：`data-ready=0` 隐藏，明文码照样能转抄。
 */
import { pairQrPayload } from "@/lib/rcShortCode";
import { QrCanvas } from "@/components/QrCanvas";
import styles from "./RemoteComputerA2.module.css";

export function RcShortCodeQr({ code, size = 140, onError }: { code: string; size?: number; onError?: () => void }) {
  // 空码不能画：pairQrPayload("") 会返回 "PP--"（非空），故这里显式传空串让 QrCanvas 跳过出码
  return (
    <QrCanvas
      text={code ? pairQrPayload(code) : ""}
      size={size}
      ariaLabel="配对码二维码"
      className={styles.pairQr}
      onError={onError}
    />
  );
}
