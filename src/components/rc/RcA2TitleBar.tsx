/**
 * RcA2TitleBar — 工作台标题栏，兼作窗口拖拽区（批7 起窗口是 decorations(false)）。
 *
 * 照 A 方案稿 `.titlebar` 的三格布局：**品牌 | 状态位 | 窗口按钮**。
 *
 * 🔴 与旧版的区别（批7 重排，2026-09-22）：
 *  1. 稿子的这一条是**纯 chrome**——原先挂在这里的「检测设备」「启动远程通道」
 *     两个操作按钮都下了架：前者下放到设备行（在线「连接」/ 离线「检测」），
 *     后者变成中间那格状态位的**自适应**形态（已启动只读、未启动可点）。
 *  2. `data-tauri-drag-region` 从 `""` 改成 `"deep"`。裸属性的语义是「只有直接点在
 *     本条自身空白处才拖」（子元素一律阻断），标题栏里塞着按钮和文字，实际没几处
 *     能按到；`deep` 让整个子树都可拖，而**可点击元素（button/link/input…）不带该
 *     属性时由 Tauri 自动豁免**，所以按钮不用逐个标 `="false"`。
 *     双击本条 = 最大化切换，也是 Tauri 内置的（`internal_toggle_maximize`）。
 *  3. 状态位**优先显示会话态文案**：被别人远程 / 有申请在等对方同意，比
 *     「通道已开启」紧急。会话真正开始（surface=session）时整条标题栏会被
 *     `hidesWorkbenchTitleBar` 收掉，那一态另有 `RcSessionTop` 承担拖拽与关闭。
 */
import { MonitorUp } from "lucide-react";
import { RcWindowControls } from "./RcWindowControls";
import styles from "./RemoteComputerA2.module.css";

export function RcA2TitleBar({
  channelUp,
  busy,
  sessionLabel,
  onStartChannel,
}: {
  /** 远程通道是否已启动（`rc.status.running`）。 */
  channelUp: boolean;
  /** 启动中：未启动态的那个按钮要禁用，避免连点。 */
  busy: boolean;
  /** 会话态文案（被别人远程 / 有申请等待）。空串 = 无会话，看通道状态。 */
  sessionLabel: string;
  onStartChannel: () => void;
}) {
  return (
    /* role="banner" 显式写出来（不依赖 <header> 的隐含角色）：这一条就是本窗口的
       全局头，测试按 landmark 定位比按品牌文案稳——品牌文案会改。 */
    <header className={styles.titleBar} role="banner" data-tauri-drag-region="deep">
      {/* 品牌：稿子 `.brand`——图标 mark + 「PastePanda」+ 灰字「远程电脑」 */}
      <div className={styles.brand}>
        <span className={styles.brandIcon} aria-hidden="true">
          <MonitorUp size={15} />
        </span>
        <span className={styles.brandName}>PastePanda</span>
        <span className={styles.brandSection}>远程电脑</span>
      </div>

      {/* 状态位：有会话态文案就让它占位，否则报通道状态。
          两态都是「圆点 + 一句话」，只差颜色与可点性——与稿子的单一形态同构，
          免得看起来像两种不同的东西。 */}
      {sessionLabel ? (
        <span className={styles.channelStatus}>
          <span className={styles.channelDot} aria-hidden="true" />
          {sessionLabel}
        </span>
      ) : channelUp ? (
        <span className={styles.channelStatus}>
          <span className={styles.channelDot} aria-hidden="true" />
          远程通道已开启
        </span>
      ) : (
        /* 未启动 = 可点。这不是装饰性的状态字：正常路径下通道由 boot 与
           「打开工作台自动启动」拉起，这里是**两条都失败时的补救入口**——
           压成纯只读就再也没有地方能把它开起来了。 */
        <button
          type="button"
          className={styles.channelBtn}
          disabled={busy}
          onClick={onStartChannel}
          title="本机的远程通道当前没有运行，点此手动开启；开启后才能发起与接收远程会话"
        >
          <span className={`${styles.channelDot} ${styles.channelDotOff}`} aria-hidden="true" />
          通道未启动 · 点击开启
        </button>
      )}

      {/* 右格：自绘窗口按钮（最小化 / 最大化·还原 / 关闭） */}
      <RcWindowControls />
    </header>
  );
}
