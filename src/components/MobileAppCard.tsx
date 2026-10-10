/**
 * MobileAppCard —— 「关于」页的「手机 App 下载」入口。
 *
 * 需求：多数用户只在电脑端，不知道有安卓手机端 App。这里给出下载入口——
 * 主形态是**二维码**（深块浅底、margin 静区，见 QrCanvas），扫/点均指向
 * GitHub 发布页 `releases/latest`（常驻、带更新说明、挂着 universal-release.apk），
 * 展开区再列 Gitee 镜像（国内快）与项目主页。
 *
 * ❗ 为什么不指 `pastepanda.pages.dev/#android`：那是**独立部署的落地页，不在本仓**，
 * 当前只有 Windows 下载区，手机扫过去会落到「下载 Windows」的死胡同。落地页补 Android 区
 * 需在其自己的站点仓做，不属于本次改动能覆盖的范围；这里改用真实可下到 APK 的发布页兜住。
 *
 * 反馈口径（规则 15.1）：复制成功直接在按钮上常驻显示「已复制 ✓」，不靠 toast——
 * 触发（复制按钮）与反馈（按钮文案）在同一个可见域，任何滚动位置都看得见。
 *
 * 出码失败（qrcode 加载不了 / canvas 不可用）不弹不闹：二维码位换成一句人话，
 * 「复制链接 / 打开下载页」两个按钮照常可用。
 */
import { useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { QrCanvas } from "./QrCanvas";
import { copyToClipboard } from "@/lib/utils";
import styles from "./MobileAppCard.module.css";

/** 二维码/复制/打开三者共用同一目标：真实、常驻、含 APK 的发布页。 */
const DOWNLOAD_URL = "https://github.com/lzlkyb/pastepanda/releases/latest";

/**
 * 真正给得出安卓安装包的两条源。❗ 项目主页 pastepanda.pages.dev **不在此列**：
 * 它是独立部署、当前只有 Windows 下载区，放进来会被误当安卓下载点（点开下到的是电脑包）。
 * 所以它降级成下面 `HOME_URL` 那条「了解产品」灰链，与下载源分开。
 */
const DOWNLOAD_SOURCES = [
  { label: "github.com/lzlkyb/pastepanda/releases/latest", url: DOWNLOAD_URL, tag: "GitHub · 含更新说明" },
  { label: "gitee.com/lzul/pastepanda/releases", url: "https://gitee.com/lzul/pastepanda/releases", tag: "Gitee 镜像 · 国内快" },
];
const HOME_URL = "https://pastepanda.pages.dev/";
const HOME_LABEL = "pastepanda.pages.dev";

/** URL 一律走后端 open_url（协议白名单 http/https），不直接调 plugin-opener。 */
async function openExternal(url: string) {
  try {
    await invoke("open_url", { url });
  } catch (e) {
    console.warn("打开链接失败", e);
  }
}

export function MobileAppCard() {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const [qrFailed, setQrFailed] = useState(false);
  // 首次进关于页时 qrcode 懒加载有 ~百毫秒空白；出码成功前在框内显示「生成中」占位（规则 9 边界态）。
  const [qrReady, setQrReady] = useState(false);
  const copyTimer = useRef<number | null>(null);

  useEffect(() => () => {
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
  }, []);

  const handleCopy = async () => {
    const ok = await copyToClipboard(DOWNLOAD_URL);
    if (!ok) return;
    setCopied(true);
    if (copyTimer.current) window.clearTimeout(copyTimer.current);
    copyTimer.current = window.setTimeout(() => setCopied(false), 1500);
  };

  return (
    <div className={styles.card}>
      <div className={styles.cardHead}>
        <span className={styles.cardIcon}>📱</span>
        <span className={styles.cardTitle}>手机 App</span>
        <span className={styles.cardBadge}>Android</span>
      </div>
      <p className={styles.cardDesc}>
        把 PastePanda 装到安卓手机：随时随地<b>收发粘贴</b>、用<b>手机连你的电脑</b>远程取用。
        用手机自带的<b>相机扫下面的码</b>即可开始下载。
      </p>

      <div className={styles.dlRow}>
        <div className={styles.qrWrap}>
          <div className={styles.qrFrame}>
            {qrFailed ? (
              <div className={styles.qrFail}>二维码加载失败，可用下方「复制链接 / 打开下载页」</div>
            ) : (
              <>
                {/* 懒加载 qrcode 那 ~百毫秒的占位：canvas 此刻 data-ready=0 被 CSS 藏起，这里补一句人话，别留白块 */}
                {!qrReady && <div className={styles.qrLoading}>二维码生成中…</div>}
                <QrCanvas
                  text={DOWNLOAD_URL}
                  size={142}
                  className={styles.qrCanvas}
                  ariaLabel="手机 App 下载二维码"
                  onReady={() => setQrReady(true)}
                  onError={() => setQrFailed(true)}
                />
              </>
            )}
          </div>
          <div className={styles.qrCap}>扫一扫，手机打开下载页</div>
        </div>

        <div className={styles.dlSide}>
          <div className={styles.hintStep}>1. 手机用<b>相机</b>对准左侧二维码</div>
          <div className={styles.hintStep}>2. 点通知打开下载页，选一个能连通的源</div>
          <div className={styles.hintStep}>3. 安装时按提示允许「未知来源」</div>
        </div>
      </div>

      {/* 按钮与展开入口是 .card 的整宽直接子节点（对齐 SponsorCard）：
          放进 QR 旁的窄列里会在窄窗下把「打开下载页」折成两行——那是本次要修的观感问题。 */}
      <div className={styles.cardBtns}>
        <button type="button" className={`${styles.cardBtn} ${copied ? styles.cardBtnCopied : ""}`} onClick={() => void handleCopy()}>
          {copied ? "已复制 ✓" : "复制链接"}
        </button>
        <button type="button" className={`${styles.cardBtn} ${styles.cardBtnPrimary}`} onClick={() => void openExternal(DOWNLOAD_URL)}>
          打开下载页
        </button>
      </div>
      <button type="button" className={styles.moreBtn} onClick={() => setExpanded((v) => !v)} aria-expanded={expanded}>
        {expanded ? "收起下载方式与安装说明 ▴" : "更多下载方式与安装说明 ▾"}
      </button>

      {expanded && (
        <div className={styles.more}>
          <div className={styles.moreLabel}>下载源（二选一，按你的网络）</div>
          <div className={styles.srcList}>
            {DOWNLOAD_SOURCES.map((s) => (
              <div key={s.url} className={styles.src}>
                <button type="button" className={styles.srcLink} onClick={() => void openExternal(s.url)}>
                  {s.label}
                </button>
                <span className={styles.srcTag}>{s.tag}</span>
              </div>
            ))}
          </div>
          {/* 国内主路径是 GitHub，但 GitHub 在国内常慢/连不上——主动给逃生口，别让用户扫完码卡在第一屏 */}
          <div className={styles.srcNote}>GitHub 慢或打不开 → 改用 Gitee 镜像，装的是同一个安装包。</div>
          <div className={styles.homeRow}>
            <button type="button" className={styles.srcLink} onClick={() => void openExternal(HOME_URL)}>
              {HOME_LABEL}
            </button>
            <span className={styles.srcTag}>项目主页 · 了解 PastePanda</span>
          </div>
          <div className={styles.guide}>
            <b>装不上？Android 安全限制需要一步手动允许：</b>
            <ol>
              <li>下载得到 <code>.apk</code> 文件后点开；</li>
              <li>系统提示「禁止安装未知应用」→ 设置 → 允许此来源；</li>
              <li>返回再点安装包即可完成，本地数据不丢。</li>
            </ol>
          </div>
        </div>
      )}
    </div>
  );
}
