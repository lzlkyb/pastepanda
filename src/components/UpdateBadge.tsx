import { useState, useEffect, useCallback } from "react";
import { motion, AnimatePresence, useMotionValue, useSpring } from "framer-motion";
import type { TargetAndTransition, Transition } from "framer-motion";
import { useUpdate, friendlyError } from "@/contexts/UpdateContext";
import { ArrowDown, Loader2, CheckCircle, AlertCircle, RotateCcw, RefreshCw } from "lucide-react";
import styles from "./UpdateBanner.module.css";

/** 下载速率格式化（如 "1.2 MB/s"） */
function formatBytesPerSec(bytesPerSec: number): string {
  if (bytesPerSec <= 0) return "";
  if (bytesPerSec < 1024) return `${bytesPerSec} B/s`;
  if (bytesPerSec < 1024 * 1024) return `${(bytesPerSec / 1024).toFixed(1)} KB/s`;
  return `${(bytesPerSec / (1024 * 1024)).toFixed(1)} MB/s`;
}

/** Header 下载进度环：14px SVG 圆环，确定态显示百分比弧，不确定态整体旋转 */
function DownloadRing({ progress, indeterminate }: { progress: number; indeterminate: boolean }) {
  const size = 14;
  const stroke = 2.5;
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const clamped = Math.min(100, Math.max(0, progress));
  const target = indeterminate ? c * 0.75 : c * (1 - clamped / 100);
  /**
   * 弧长做弹簧补间。后端 `on_chunk` 是**按 chunk** 回调的（进度不是匀速来的），
   * 稀疏时百分比会 7%、13% 地往上蹦，直接写进 strokeDashoffset 就是一格一格跳。
   *
   * ❗ 只补圆环，**不补百分比数字**：数字做补间会出现「45→44→46」的回跳感，
   * 而人读数字是逐帧读的，读到回跳就会觉得数据不可信。
   */
  const raw = useMotionValue(target);
  const smooth = useSpring(raw, { stiffness: 90, damping: 20 });
  useEffect(() => {
    raw.set(target);
  }, [raw, target]);
  return (
    <svg
      width={size} height={size} viewBox={`0 0 ${size} ${size}`}
      className={indeterminate ? "spin-icon" : ""}
      aria-hidden="true"
    >
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="rgba(255,255,255,0.3)" strokeWidth={stroke} />
      <motion.circle
        cx={size / 2} cy={size / 2} r={r} fill="none"
        stroke="#fff" strokeWidth={stroke} strokeLinecap="round"
        strokeDasharray={c} strokeDashoffset={smooth}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
    </svg>
  );
}

/**
 * 名位进出：接管态徽章与应用名共用**同一套**。
 * 改之前是两套——名字走 `y:±4`、徽章走 `scale 0.8`，同一个位置上两种动画语言；
 * 而且 0.8 在 20px 高的徽章上过于夸张。
 */
const SLOT_SWAP: {
  initial: TargetAndTransition;
  animate: TargetAndTransition;
  exit: TargetAndTransition;
  transition: Transition;
} = {
  initial: { opacity: 0, y: -2, scale: 0.96 },
  animate: { opacity: 1, y: 0, scale: 1 },
  exit: { opacity: 0, y: 2, scale: 0.96 },
  transition: { duration: 0.13, ease: "easeOut" },
};

/**
 * 可点徽章的按压反馈。
 *
 * 0.92 而不是卡片那套 0.985（`Card.tsx:337`）：徽章只有 20px 高，
 * 0.985 在这个尺寸上肉眼看不见，等于没加。
 */
const TAP: TargetAndTransition = {
  scale: 0.92,
  transition: { type: "spring", stiffness: 600, damping: 22 },
};

/**
 * 手动检查的四个阶段。
 *
 * 🔴 后台自动轮询**不**进这个状态机——名位归属只有用户自己点了才会变。
 * 这就是「自动检查不该抢名位」那条原则的实现方式：不是判断 status 是不是
 * checking，而是判断**这一轮是谁发起的**。
 */
type ManualPhase = "none" | "pending" | "checking" | "uptodate" | "error";

/**
 * 手动检查期间占住名位的状态徽章。
 *
 * 🔴 它存在的理由：在这之前，点「检查更新」→ status 变 checking →
 * `nameClickable` 变 false → 按钮被换成裸应用名，**连正在悬停的那个徽章都缩回去了**，
 * 反馈是「负的」，像一点就把提示弄丢了；查完是「已是最新」还是「查失败」也一声不响。
 * 点了等于没点。
 *
 * `-uptodate` / `-error` 两个变体的 CSS 早就写在 `app.css` 里，只是一直没人渲染。
 */
function ManualCheckBadge({ phase, ver, onRetry }: { phase: ManualPhase; ver: string; onRetry: () => void }) {
  if (phase === "uptodate") {
    return (
      <span className="header-badge header-badge-uptodate" title="已经是最新版本">
        <CheckCircle size={11} />
        {ver ? `已是最新 v${ver}` : "已是最新"}
      </span>
    );
  }
  if (phase === "error") {
    return (
      <motion.button
        type="button"
        whileTap={TAP}
        className="header-badge header-badge-error"
        title="检查更新失败，点击重试"
        onClick={onRetry}
      >
        <AlertCircle size={11} />
        检查失败，重试
      </motion.button>
    );
  }
  // pending / checking 共用一个外观：pending 是「点下去那一帧就变」的乐观显示。
  // 用户分不出后端有没有真的开始，也不需要分——他要的是「我点上了」这个确认。
  return (
    <span className="header-badge header-badge-checking" title="正在检查更新…">
      <RefreshCw size={11} className="spin-icon" />
      检查中…
    </span>
  );
}

/**
 * TopBar 名位复用徽章（D15）。
 *
 * **它不是一个被动的版本号展示，是更新链路的唯一主动入口**。删它 = 用户再也
 * 收不到更新提醒（叠上已知的 Gitee 镜像风险，就是真的发不出去）。
 *
 * 名位复用：应用名与更新状态**共用标题行同一个位置**，只有带可执行动作的状态
 * 才接管，接管结束名字立刻回来。省下的宽度正好给了模式切换器（ModeSwitcher）。
 *
 * 为何 checking/error/uptodate 不**接管外观**：它们没有用户马上要看的东西，而名位反复闪
 * 比不显示更吵。
 *
 * 🔴 但「不接管外观」不等于「不可点」——这一步之前搞反了：
 * 名位占着主窗口一等位置，却在 idle/uptodate 这个**占 90% 时间**的状态下是个死标签；
 * error 时用户在主窗口连重试都做不了。手动检查虽然在**设置 → 关于**里有，
 * 但那是三层之外，等于“只能等弹窗自己冒出来”。
 * 现在 idle/uptodate/error 下名字本身就是按钮，悬停变成「🔄 检查更新 · v7.x」——
 * 不多占一像素，而那个位置本来就闲着。
 *
 * 未读说明红点已删（不要加回来）：与设置页「关于」tab 的红点 + `UpdateNotesDialog`
 * 自动弹窗重复，是同一件事的第三个入口；删后副作用正好是想要的——**重启后名字立刻回来**。
 *
 * @param nameSlot 不接管时渲染的应用名节点。由 TopBar 传入而不是在这里拼，因为它的
 *   样式（.brandTitle / .headerTitleText / AiMark）属于 TopBar 的 CSS module。
 *
 * 名位各状态：
 * - idle / checking / error / uptodate：**应用名（nameSlot）**
 * - available：绿色可点击 [🔄 v5.0.71] 点击下载
 * - downloading：[⏳ 45%]
 * - ready/installed：[✅ 重启]
 * - **用户手点检查期间**：[🔄 检查中…] → [✅ 已是最新 v6.x] / [⚠ 检查失败，重试]
 *   （见 ManualPhase：只有**用户自己点的**那一轮才占名位，后台轮询不占）
 *
 * 使用 AnimatePresence + key 实现状态切换进出动画。外层用 `mode="wait"`（它的
 * 父节点属于 TopBar，不在这里动它的定位）；名字↔悬停提示那一层用
 * `mode="popLayout"`，理由写在那一处。
 */
export function UpdateBadge({ nameSlot }: { nameSlot: React.ReactNode }) {
  // available 显的是**新**版本（`update?.version`）；当前版本号不常驻显示，
  // 只在名字位悬停时作为提示的一部分出现（见下面的 `ver`）。
  const { status, update, progress, progressIndeterminate, downloadedBytes, bytesPerSec, checkForUpdate, downloadAndInstall, restart } = useUpdate();
  // 防止用户快速重复点击（连点更新徽章）导致重复触发检查/下载/重启
  const [isStarting, setIsStarting] = useState(false);
  /** 名字位是否悬停（含键盘聚焦）。 */
  const [nameHover, setNameHover] = useState(false);
  /**
   * 当前版本号。**悬停时才去取**：静态下用不到它，
   * 不必为一个悬停提示在启动时多一次 invoke（规则 #8）。
   */
  const [ver, setVer] = useState("");
  /** 手动检查的进程（见 ManualPhase）。后台自动轮询恒为 "none"。 */
  const [phase, setPhase] = useState<ManualPhase>("none");

  /** 取当前版本号（悬停提示与手动检查结果都要用，只取一次）。 */
  const loadVer = useCallback(() => {
    if (ver) return;
    import("@/lib/api")
      .then((m) => m.getAppVersion().then(setVer))
      .catch(() => {
        /* 拿不到版本号就只显文字，不影响主功能 */
      });
  }, [ver]);

  /** idle / uptodate / error 下名字可点 = 手动检查；checking 时不可点（已经在查了）。 */
  const nameClickable = status === "idle" || status === "uptodate" || status === "error";

  /** 接管态：有新版 / 在下载 / 待重启——名位归它们。 */
  const takeover =
    status === "available" || status === "downloading" || status === "ready" || status === "installed";

  /** 名字按钮此刻在不在场。 */
  const nameBtnShown = !takeover && phase === "none" && nameClickable;

  /**
   * 🔴 名字按钮一旦下场，就把 `nameHover` 清掉。
   *
   * 它是被**卸载**的（点检查后换成状态徽章、或被接管态顶掉、或后台检查中变不可点），
   * 而**卸载不会触发 `onMouseLeave`**——nameHover 会一直停在 true。
   * 等名位还回来时（鼠标早就移开了）它会直接渲染成悬停徽章，
   * 而且**再也不会自己恢复成应用名**：要清掉它得先「离开」一次，可指针不在那里了。
   * （2026-09-06 用户实测：点完检查、没新版本、鼠标已移开，名位卡在版本徽章上。）
   *
   * ❗ 这里盯的是「按钮在不在场」而不是「手动检查开始了」：两条卸载路径同病，
   * 只堵前一条的话，「悬停着名字时后台发现新版本」那条还是坏的。
   */
  useEffect(() => {
    if (!nameBtnShown) setNameHover(false);
  }, [nameBtnShown]);

  /**
   * 手动检查的状态机推进。
   *
   * 🔴 为何要等 `checking` 出现过才认结果：用户在 `error` 下点重试，这一帧
   * status 还是 `error`——直接认就会在新一轮还没开始时先报一次「检查失败」；
   * 同理在 `uptodate` 下点检查会立刻报「已是最新」。那是在编造一个没发生过的结果。
   * 所以 pending 只接受「进入 checking」，结果只在 checking 之后认。
   */
  useEffect(() => {
    if (phase === "none") return;
    // 接管态自己会占名位，手动检查让位
    if (phase === "pending") {
      if (status === "checking") setPhase("checking");
      else if (takeover) setPhase("none");
      // idle/uptodate/error = 这一轮还没开始，继续显「检查中」，由下面的安全定时器兜底
      return;
    }
    if (phase === "checking") {
      if (status === "uptodate") setPhase("uptodate");
      else if (status === "error") setPhase("error");
      else if (status !== "checking") setPhase("none");
    }
  }, [phase, status, takeover]);

  /**
   * 结果只停一下就把名位还回去（名位是应用名的地盘，不是通知栏）。
   *
   * ❗ pending 的长兜底不能省：万一 `checkForUpdate()` 在 UpdateContext 内部抛了、
   * status 一直不动，名位就会永久卡在「检查中…」——那比没反馈更糟。
   */
  useEffect(() => {
    const ms = phase === "uptodate" ? 1800 : phase === "error" ? 3000 : phase === "pending" ? 12000 : 0;
    if (!ms) return;
    const t = setTimeout(() => setPhase("none"), ms);
    return () => clearTimeout(t);
  }, [phase]);

  const enterName = () => {
    setNameHover(true);
    loadVer();
  };

  /** 点名字 = 手动检查。立刻进 pending（**不等后端**）才有「点上了」的手感。 */
  const startCheck = () => {
    loadVer();
    setPhase("pending");
    void checkForUpdate();
  };

  const handleClick = async () => {
    if (isStarting) return;
    setIsStarting(true);
    try {
      if (status === "available") {
        await downloadAndInstall();
      } else if (status === "ready" || status === "installed") {
        await restart();
      }
    } finally {
      setIsStarting(false);
    }
  };

  return (
    <AnimatePresence mode="wait">
      {/* 有新版本：替换版本号，显示可点击的绿色更新按钮 */}
      {status === "available" && (() => {
        const ver = update?.version ?? "";
        return (
          <motion.button
            key="update-available"
            // 入场：从上方落下 + 轻过冲，**只演一次**。
            // 持续提醒仍然交给 CSS 的 badge-pulse（2s 呼吸），不叠加。
            initial={{ opacity: 0, y: -8, scale: 0.92 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={SLOT_SWAP.exit}
            transition={{ type: "spring", stiffness: 500, damping: 18 }}
            whileTap={TAP}
            className="header-badge header-badge-update"
            title={isStarting ? "正在启动下载…" : `发现新版本 v${ver}，点击下载更新`}
            onClick={handleClick}
            disabled={isStarting}
          >
            {isStarting ? (
              <>
                {/* 点下去那一帧就变，不等后端建连接/取 metadata 的那几百毫秒。
                    `isStarting` 以前只用来 disabled——按钮不能再点了，
                    但屏幕上什么都没变，那在用户看来就是「点死了」。 */}
                <Loader2 size={10} className="spin-icon" />
                <span>启动中…</span>
              </>
            ) : (
              <>
                {/* 箭头悬停时轻轻点头，暗示「点了会下载」。
                    用 CSS 而不是 framer：按压反馈已经在**按钮**上写了内联 transform，
                    而 framer 的内联样式会盖掉样式表的 transform（Card.tsx 里那条注释说的就是这个坑）。
                    分到子节点上用 CSS，两边各管各的节点，不抢同一个属性。 */}
                <span className="badge-bob"><ArrowDown size={10} /></span>
                <span>更新 v{ver}</span>
              </>
            )}
          </motion.button>
        );
      })()}

      {/* 下载中：DownloadRing 圆环 + 百分比（确定态）/ "下载中"（不确定态） + 速率 */}
      {status === "downloading" && (() => {
        const speedText = bytesPerSec > 0 ? ` · ${formatBytesPerSec(bytesPerSec)}` : "";
        const titleText = `正在下载更新…${speedText}`;
        return (
          <motion.span
            key="update-downloading"
            {...SLOT_SWAP}
            className="header-badge header-badge-downloading"
            title={titleText}
          >
            <DownloadRing progress={progress} indeterminate={progressIndeterminate} />
            <span>{progressIndeterminate ? `下载中 ${(downloadedBytes / 1048576).toFixed(1)} MB${speedText}` : `下载中 ${progress}%${speedText}`}</span>
          </motion.span>
        );
      })()}

      {/* 已就绪/已安装 */}
      {(status === "ready" || status === "installed") && (
        <motion.button
          key="update-ready"
          initial={{ opacity: 0 }}
          animate={{ opacity: 1 }}
          exit={SLOT_SWAP.exit}
          transition={SLOT_SWAP.transition}
          whileTap={TAP}
          className="header-badge header-badge-ready"
          title={isStarting ? "正在重启…" : "更新已安装，点击重启"}
          onClick={handleClick}
          disabled={isStarting}
        >
          {/* 「下完了」要被强调一次：缩放脉冲放在**内层** span 上。
              放按钮上会和 whileTap 的内联 transform 抢同一个属性（同上）。 */}
          <span className="badge-pop">
            {isStarting ? <Loader2 size={10} className="spin-icon" /> : <RotateCcw size={10} />}
            <span>{isStarting ? "重启中…" : "重启"}</span>
          </span>
        </motion.button>
      )}

      {/* 不接管的四个状态（idle / checking / error / uptodate）→ 名位还给应用名。
          四者合一个分支共用同一个 key，才能在它们之间切换时**不触发动画**
          （名字不会因为后台检查一轮就闪一下）；与接管态之间才淡入淡出。 */}
      {!takeover && (
        <motion.span key="app-name" {...SLOT_SWAP}>
          {/* 手动检查进行中 / 刚出结果：名位交给状态徽章，**不许缩回应用名**。
              后台自动轮询走不到这里（phase 恒为 "none"），名字不会因为一轮后台检查就闪。 */}
          {phase !== "none" ? (
            <ManualCheckBadge phase={phase} ver={ver} onRetry={startCheck} />
          ) : nameClickable ? (
            <motion.button
              type="button"
              whileTap={TAP}
              className={styles.nameCheckBtn}
              // ❗ 无障碍名字写死成「检查更新」：按钮里默认渲染的是应用名，
              //   读屏器拿到「PastePanda」会完全不知道点下去会发生什么。
              aria-label="检查更新"
              title={status === "error" ? "上次检查失败，点击重试" : "点击检查更新"}
              onMouseEnter={enterName}
              onMouseLeave={() => setNameHover(false)}
              onFocus={enterName}
              onBlur={() => setNameHover(false)}
              onClick={startCheck}
            >
              {/* 悬停（或键盘聚焦）才换成提示——静态下仍然只是应用名，不吵。
                  这一下变化就是可供性提示：不然没人会想到名字能点。

                  ❗ 这里用 mode="popLayout" 而不是外层那个 "wait"：这是**最频繁**的
                  一次交换（鼠标从名字上扫过就演一遍）。用 wait 的话中间会空 130ms，
                  右边的 ModeSwitcher 先左移再回来，比硬跳还难看。
                  popLayout 把退场节点弹出文档流，宽度瞬变（与改之前一致、零回归），
                  视觉上的交换由 opacity 承担。
                  它需要一个 position:relative 的直接祖先——见 `.nameCheckBtn`。 */}
              <AnimatePresence mode="popLayout" initial={false}>
                {nameHover ? (
                  // 🔴 跟接管态用**同一套全局徽章类**（`.header-badge`），不另写一份。
                  //   改之前这里是一段裸文字，而同一个名位在 available / downloading /
                  //   ready / checking 四个状态下出的都是胶囊徽章——只有它不合群
                  //   （2026-09-06 用户反馈）。变体用 `check`（version-badge 渐变），
                  //   而不是 `update`（那套是「真有新版了」的颜色，借用会误报）。
                  <motion.span key="hint" {...SLOT_SWAP} className="header-badge header-badge-check">
                    <RefreshCw size={11} />
                    {/* 优先显版本号：这一格本来就是版本徽章的位置，
                        而「可点」已经由徽章外观 + 指针 + title 三重交代了。
                        拿不到版本号（首次悬停还在异步读）才退到文字。 */}
                    {status === "error" ? "重试检查" : ver ? `v${ver}` : "检查更新"}
                  </motion.span>
                ) : (
                  <motion.span key="name" {...SLOT_SWAP}>{nameSlot}</motion.span>
                )}
              </AnimatePresence>
            </motion.button>
          ) : (
            nameSlot
          )}
        </motion.span>
      )}
    </AnimatePresence>
  );
}

/** 设置面板"关于"tab 中使用的更新横幅 + 下载进度 */
export function UpdateBanner() {
  const { status, update, progress, progressIndeterminate, downloadedBytes, bytesPerSec, error, checkForUpdate, downloadAndInstall, restart, markInstalled, skipThisVersion } =
    useUpdate();

  const bannerKey = `banner-${status}`;

  return (
    <AnimatePresence mode="wait">
      {status === "checking" && (
        <motion.div
          key={bannerKey}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.2 }}
          className={`${styles.updateBanner} ${styles.updateBannerChecking}`}
        >
          <Loader2 size={14} className="spin-icon" />
          <div>
            <div className={styles.updateBannerTitle}>检查更新中…</div>
          </div>
        </motion.div>
      )}

      {status === "available" && (() => {
        const ver = update?.version ?? "";
        const desc = update?.body || "包含性能优化和 bug 修复";
        return (
          <motion.div
            key={bannerKey}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.2 }}
            className={`${styles.updateBanner} ${styles.updateBannerAvailable}`}
          >
            <div className={styles.updateBannerIcon}>
              <ArrowDown size={16} />
            </div>
            <div style={{ flex: 1 }}>
              <div className={styles.updateBannerTitle}>发现新版本 v{ver}</div>
              <div className={styles.updateBannerDesc}>{desc}</div>
            </div>
            <button className={styles.updateBannerBtn} onClick={downloadAndInstall}>
              <ArrowDown size={12} /> 下载更新
            </button>
            <button
              className={`${styles.updateBannerBtn} ${styles.updateBannerBtnSkip}`}
              onClick={skipThisVersion}
              title="不再提示此版本"
            >
              跳过
            </button>
          </motion.div>
        );
      })()}

      {status === "downloading" && (() => {
        const speedText = bytesPerSec > 0 ? ` · ${formatBytesPerSec(bytesPerSec)}` : "";
        return (
          <motion.div
            key={bannerKey}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.2 }}
            className={`${styles.updateBanner} ${styles.updateBannerDownloading}`}
          >
            <Loader2 size={14} className="spin-icon" />
            <div style={{ flex: 1 }}>
              <div className={styles.updateBannerTitle}>
                {progressIndeterminate ? `正在下载更新… ${(downloadedBytes / 1048576).toFixed(1)} MB` : `正在下载更新… ${progress}%`}
                <span className={styles.updateBannerSpeed}>{speedText}</span>
              </div>
              <div className={styles.updateProgressBar}>
                <div
                  className={styles.updateProgressFill}
                  style={progressIndeterminate
                    ? { width: "40%", animation: "progress-indeterminate 1.5s ease-in-out infinite" }
                    : { width: `${progress}%`, transition: "width 0.15s linear" }
                  }
                />
              </div>
              <div className={styles.updateBannerDesc}>正在从 GitHub 下载，请耐心等待</div>
            </div>
          </motion.div>
        );
      })()}

      {status === "ready" && (
        <motion.div
          key={bannerKey}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.2 }}
          className={`${styles.updateBanner} ${styles.updateBannerReady}`}
        >
          <CheckCircle size={16} style={{ color: "var(--accent)" }} />
          <div style={{ flex: 1 }}>
            <div className={styles.updateBannerTitle}>更新已下载完成</div>
            <div className={styles.updateBannerDesc}>点击重启以应用更新</div>
          </div>
          <button
            className={`${styles.updateBannerBtn} ${styles.updateBannerBtnRestart}`}
            onClick={async () => {
              markInstalled();
              await restart();
            }}
          >
            <RotateCcw size={12} /> 立即重启
          </button>
        </motion.div>
      )}

      {status === "installed" && (
        <motion.div
          key={bannerKey}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.2 }}
          className={`${styles.updateBanner} ${styles.updateBannerReady}`}
        >
          <CheckCircle size={16} style={{ color: "var(--accent)" }} />
          <div style={{ flex: 1 }}>
            <div className={styles.updateBannerTitle}>更新已安装</div>
            <div className={styles.updateBannerDesc}>需要重启应用才能生效</div>
          </div>
          <button
            className={`${styles.updateBannerBtn} ${styles.updateBannerBtnRestart}`}
            onClick={restart}
          >
            <RotateCcw size={12} /> 立即重启
          </button>
        </motion.div>
      )}

      {status === "error" && (() => {
        const fe = error ? friendlyError(error) : null;
        return (
          <motion.div
            key={bannerKey}
            initial={{ opacity: 0, y: 6 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0, y: -6 }}
            transition={{ duration: 0.2 }}
            className={`${styles.updateBanner} ${styles.updateBannerError}`}
          >
            <AlertCircle size={16} style={{ color: "var(--danger)", flexShrink: 0, marginTop: 2 }} />
            <div style={{ flex: 1, minWidth: 0 }}>
              <div className={styles.updateBannerTitle}>更新失败</div>
              <div className={styles.updateBannerDesc}>{fe?.friendly || "未知错误，请重试"}</div>
              {fe?.raw && (
                <div className={styles.updateBannerRaw}>{fe.raw}</div>
              )}
            </div>
            <button className={styles.updateBannerBtn} onClick={checkForUpdate}>
              重试
            </button>
          </motion.div>
        );
      })()}

      {(status === "idle" || status === "uptodate") && (
        <motion.div
          key={bannerKey}
          initial={{ opacity: 0, y: 6 }}
          animate={{ opacity: 1, y: 0 }}
          exit={{ opacity: 0, y: -6 }}
          transition={{ duration: 0.2 }}
          className={`${styles.updateBanner} ${styles.updateBannerIdle}`}
        >
          <CheckCircle size={14} style={{ color: "var(--accent)" }} />
          <div style={{ flex: 1 }}>
            <div className={styles.updateBannerTitle}>已是最新版本</div>
          </div>
          <button className={styles.updateBannerBtn} onClick={checkForUpdate}>
            检查更新
          </button>
        </motion.div>
      )}
    </AnimatePresence>
  );
}
