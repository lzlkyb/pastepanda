/**
 * SponsorCard —— 「关于」页的赞助开发者入口。
 *
 * 用户反馈需求：关于页里加「赞助开发者」，参考主流开源软件做法（应用内赞助卡片）。
 * 渠道：微信赞赏码 / 支付宝赞赏码，点击弹出收款码弹窗。
 *
 * ⚠️ 收款码图片：把微信/支付宝的「赞赏码」截图分别放到
 *   src/assets/sponsor/wechat.png  与  src/assets/sponsor/alipay.png
 *   覆盖现有占位图即可生效（当前为程序生成的占位图，中心带红色叉号，请勿直接发布）。
 */
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import { X } from "lucide-react";
import wechatQr from "@/assets/sponsor/wechat.png";
import alipayQr from "@/assets/sponsor/alipay.png";
import styles from "./SponsorCard.module.css";

type Channel = "wechat" | "alipay";

const CHANNELS: { key: Channel; label: string; icon: string; img: string; tip: string }[] = [
  { key: "wechat", label: "微信赞赏", icon: "💚", img: wechatQr, tip: "微信扫一扫" },
  { key: "alipay", label: "支付宝赞赏", icon: "💙", img: alipayQr, tip: "支付宝扫一扫" },
];

export function SponsorCard() {
  const [active, setActive] = useState<Channel | null>(null);
  const [imgErr, setImgErr] = useState(false);
  const chan = CHANNELS.find((c) => c.key === active) ?? null;

  // 弹窗内 Esc 关闭
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setActive(null);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);

  return (
    <>
      <div className={styles.card}>
        <div className={styles.cardHead}>
          <span className={styles.cardIcon}>🧡</span>
          <span className={styles.cardTitle}>赞助开发者</span>
        </div>
        <p className={styles.cardDesc}>
          PastePanda 完全免费开源。如果你觉得它有用，请我喝杯咖啡 —— 你的支持是我持续维护、修 Bug、加新功能的动力。
        </p>
        <div className={styles.cardBtns}>
          {CHANNELS.map((c) => (
            <button
              key={c.key}
              className={`${styles.cardBtn} ${styles[c.key]}`}
              onClick={() => {
                setImgErr(false);
                setActive(c.key);
              }}
            >
              <span className={styles.btnIcon}>{c.icon}</span>
              {c.label}
            </button>
          ))}
        </div>
      </div>

      {active && chan &&
        createPortal(
          <div className={styles.backdrop} onClick={() => setActive(null)}>
            <div
              className={styles.dialog}
              onClick={(e) => e.stopPropagation()}
              role="dialog"
              aria-label={chan.label}
            >
              <div className={styles.dialogHead}>
                <span>
                  {chan.icon} {chan.label}
                </span>
                <button className={styles.closeBtn} onClick={() => setActive(null)} aria-label="关闭">
                  <X size={15} />
                </button>
              </div>
              <div className={styles.dialogBody}>
                <div className={styles.qrWrap}>
                  {imgErr ? (
                    <div className={styles.qrErr}>
                      收款码图片缺失，请把截图放到 src/assets/sponsor/{chan.key}.png 后重试
                    </div>
                  ) : (
                    <img
                      src={chan.img}
                      alt={chan.label}
                      className={styles.qr}
                      onError={() => setImgErr(true)}
                    />
                  )}
                </div>
                <div className={styles.dialogTip}>{chan.tip}，支持一下开发者 🧡</div>
                <div className={styles.dialogFoot}>
                  <button className={styles.doneBtn} onClick={() => setActive(null)}>
                    谢谢支持
                  </button>
                </div>
              </div>
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}
