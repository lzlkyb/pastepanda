/**
 * RcNavRail — 工作台左侧导航（v5 沉浸工作台，2026-09-19）。
 *
 * 骨架沿用 v4：logo + 四个导航项（远程电脑 / 设备列表 / 会话记录 / 设置）。
 * 其余三页是同一份数据的另一种浏览方式，不是新后端——数据全部来自已有的
 * `rc.targets` / `rc_session_history` / `rc_status`。
 *
 * v5 两处升级（design/远程电脑-v5-沉浸工作台-设计稿.html）：
 * 1. **滑动胶囊**：完整导航的激活背景是**一个**绝对定位元素（navPill），切页签时
 *    transform 滑到目标行（spring 曲线）——替代每项各自的静态渐变块。行高与间距
 *    是常量（40 + 4），滑距可以纯算术得出，不需要测量 DOM。
 * 2. **本机状态胶囊**：侧栏脚注从 static 小字升级为真实数据（identity 设备名 +
 *    running + 指纹缩写）。通道未启动时整颗就是启动入口（点击 = startChannel），
 *    已开启时是只读状态展示——不摆第二个「关闭通道」危险入口。
 *
 * 🔴 会话折叠（沿用 v4 的有意偏差，见 RcWorkbench 顶部说明）：出站会话进行中收成
 * 56px 图标轨，收起态保留展开入口，离开会话即复位。
 */
import {
  History,
  List,
  Monitor,
  Settings,
  FolderUp,
  ChevronRight,
  ShieldCheck,
  ShieldOff,
} from "lucide-react";
import type { RcIdentity } from "@/lib/api/rc";
import type { WbPage } from "@/lib/rcWorkbench";
import styles from "./RemoteComputer.module.css";

/**
 * 导航项。**导出是为了守卫单测**（`rcWorkbench.test.ts` 拿它与 `WB_PAGES` 对账）：
 * 新增一个 `WbPage` 却忘了往这里加，那一页就永远到不了——`tsc` 不报、运行时也没有
 * 报错，只是「这个功能好像不存在」。
 */
export const RC_NAV_ITEMS: { key: WbPage; label: string; icon: typeof Monitor }[] = [
  { key: "rc", label: "远程电脑", icon: Monitor },
  // G6：文件传输是独立通道（不建会话也能传），所以它是并列的一页，不是主页面板
  { key: "files", label: "文件传输", icon: FolderUp },
  { key: "devices", label: "设备列表", icon: List },
  { key: "history", label: "会话记录", icon: History },
  { key: "settings", label: "设置", icon: Settings },
];

/** navList 的行距常量：item 40px + gap 4px。改 CSS 时这里必须同步。 */
const NAV_STRIDE = 44;

export function RcNavRail({
  page,
  compact,
  selfEnabled,
  channelUp,
  identity,
  onNavigate,
  onExpand,
  onStartChannel,
}: {
  page: WbPage;
  /** 出站会话进行中的收起态：只留图标，点展开恢复（见顶部说明）。 */
  compact: boolean;
  /** 本机「允许被远程」状态（真源 `rc_status.enabled`）——收起态的盾形图标用它。 */
  selfEnabled: boolean;
  /** 远程通道是否在跑（`rc_status.running`）——本机状态胶囊的状态与点击语义。 */
  channelUp: boolean;
  /** 本机远程身份（设备名 + 指纹缩写显示用）；未取到按「本机」兜底。 */
  identity: RcIdentity | null;
  onNavigate: (p: WbPage) => void;
  /** 仅 compact 时使用的展开出口。 */
  onExpand: () => void;
  /** 通道未启动时，本机状态胶囊的点击动作（启动通道）。 */
  onStartChannel: () => void;
}) {
  if (compact) {
    return (
      <nav className={`${styles.navRail} ${styles.navRailCompact}`} aria-label="远程电脑导航">
        <button
          type="button"
          className={styles.railBtn}
          title="展开导航与设备"
          aria-label="展开导航与设备"
          onClick={onExpand}
        >
          <ChevronRight size={16} />
        </button>
        <div className={styles.navCompactSep} />
        {RC_NAV_ITEMS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            className={`${styles.navItem} ${page === key ? styles.navItemActive : ""}`}
            title={label}
            aria-label={label}
            aria-current={page === key ? "page" : undefined}
            onClick={() => onNavigate(key)}
          >
            <Icon size={15} className={styles.navIcon} />
          </button>
        ))}
        <div className={styles.navSp} />
        {selfEnabled ? (
          <ShieldCheck size={16} className={styles.railIconOn} aria-label="本机允许被远程：开">
            <title>本机允许被远程：开</title>
          </ShieldCheck>
        ) : (
          <ShieldOff size={16} className={styles.railIconOff} aria-label="本机允许被远程：关">
            <title>本机允许被远程：关</title>
          </ShieldOff>
        )}
      </nav>
    );
  }

  const activeIndex = Math.max(
    0,
    RC_NAV_ITEMS.findIndex(({ key }) => key === page),
  );

  return (
    <nav className={styles.navRail} aria-label="远程电脑导航">
      <div className={styles.navLogo}>
        <span className={styles.navLogoIco} aria-hidden="true">
          <Monitor size={20} />
        </span>
        <span className={styles.navLogoText}>
          <span className={styles.navLogoName}>远程电脑</span>
          <span className={styles.navLogoSub}>PastePanda 工作台</span>
        </span>
      </div>

      <div className={styles.navList} role="list">
        {/* 滑动胶囊：单一元素 + transform（性能预算总闸②），滑距 = 行序 × 行距 */}
        <span
          className={styles.navPill}
          aria-hidden="true"
          style={{ transform: `translateY(${activeIndex * NAV_STRIDE}px)` }}
        />
        {RC_NAV_ITEMS.map(({ key, label, icon: Icon }) => (
          <button
            key={key}
            type="button"
            className={`${styles.navItem} ${page === key ? styles.navItemActive : ""}`}
            aria-current={page === key ? "page" : undefined}
            onClick={() => onNavigate(key)}
          >
            <Icon size={15} className={styles.navIcon} aria-hidden="true" />
            <span className={styles.navText}>{label}</span>
          </button>
        ))}
      </div>

      <div className={styles.navSp} />
      <button
        type="button"
        className={styles.selfCap}
        disabled={channelUp}
        title={channelUp ? "本机远程身份与通道状态" : "启动远程通道"}
        onClick={onStartChannel}
      >
        <span className={`${styles.scDot} ${channelUp ? "" : styles.scDotOff}`} aria-hidden="true" />
        <span className={styles.scT}>
          <b>{identity?.device_name?.trim() || "本机"}</b>
          <span>{channelUp ? "通道已开启" : "通道未启动 · 点击开启"}</span>
        </span>
        {identity?.fingerprint && (
          <span className={styles.scFp}>{identity.fingerprint.slice(0, 4).toUpperCase()}</span>
        )}
      </button>
    </nav>
  );
}
