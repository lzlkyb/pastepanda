/**
 * RcPageSettings — 工作台内「设置」页（v4 设计稿 A 窗「去摆设版」，2026-09-19）。
 *
 * 纪律：**每一行都必须有真数据或真动作**——盘点发现旧版 6 行里 2 行与主页重复、
 * 1 行是纯文字说明、3 行只是跳转（design/远程电脑-设置去摆设与美化-设计稿.html）。
 * 同一设置只有一个家：
 * - 「允许被远程」常驻工作台侧栏；「本机画质 / 采集范围」只在主窗口设置页（本页页脚有入口），
 *   工作台内不提供——A2 设计稿本就没给画质留位置（2026-09-22 校正：旧文案「常驻主页左栏」
 *   在 A2 重构后已不成立，旧侧栏 `RcWorkbenchSide` 亦已作死代码删除）；
 * - 「被控能力上限」= 后端 `rc_status.capability`（rc_set_capability 持久写
 *   config，服务端 max_capability() 真实钳制入站授权）；主窗「被控上限」组（RcCapGroup）同款；
 * - 「默认发起方式」「自动开通道」是纯前端偏好（lib/rcRequest / lib/rcPrefs）。
 * 顶栏不摆「恢复默认」：没有对应后端，摆了就是新的摆设。
 *
 * 2026-09-21（A 方案稿对账）：补上「无人值守」分区——稿在设置页就摆了这两行，
 * 而实现此前只留一个「更多设置在主窗口」的跳转链接。功能与弹层（RcUnoDialog
 * 的 generate / pass 两种 side）早已齐全，缺的只是本页入口。
 */
import { useEffect, useState } from "react";
import { rcSessionHistory, type RcCapability } from "@/lib/api/rc";
import { readAutoStartChannel, writeAutoStartChannel } from "@/lib/rcPrefs";
import type { UseRc } from "@/hooks/useRc";
import type { useToast } from "@/components/Toast";
import { RcHistoryClearButton } from "./RcPageHistory";
import settings from "@/components/Settings.module.css";
import styles from "./RemoteComputer.module.css";
import { RcReceiveDirectorySetting } from "./RcReceiveDirectorySetting";
import { RcSettingsChoiceTags } from "./RcSettingsChoiceTags";

export function RcPageSettings({
  rc,
  cap,
  toast,
  onSetDefaultCap,
  onOpenSettings,
  onNavigateHistory,
  onManageTrusted,
  onOpenUno,
}: {
  rc: UseRc;
  /** 「默认发起方式」当前档（useRcLaunch 的记忆档，localStorage 持久）。 */
  cap: RcCapability;
  toast: ReturnType<typeof useToast>["toast"];
  onSetDefaultCap: (c: RcCapability) => void;
  /** 页脚逃生门：跳主窗口设置页的 rc 分区。 */
  onOpenSettings: () => void;
  onNavigateHistory: () => void;
  /** U10：管理免确认设备 = 切到设备页并打开 trusted 过滤（不再让用户逐台翻）。 */
  onManageTrusted: () => void;
  /**
   * 无人值守的两个入口（生成接入码 / 设置固定密码）。
   * 弹层由调用方挂载 —— 与配对弹层同一个 `RcPairLayer`，这里只发意图。
   */
  onOpenUno: (mode: "unoGenerate" | "unoPass") => void;
}) {
  /** 「免确认设备」计数（targets.trusted）。 */
  const trustedCount = rc.targets.filter((t) => t.trusted).length;
  /** 会话记录条数：进页面读一次（上限 20 条，读起来很便宜）。 */
  const [historyCount, setHistoryCount] = useState<number | null>(null);
  /** 自动开通道是本窗口偏好：内存态即时反馈 + localStorage 持久。 */
  const [autoChannel, setAutoChannel] = useState(() => readAutoStartChannel());

  useEffect(() => {
    let alive = true;
    void rcSessionHistory()
      .then((list) => {
        if (alive) setHistoryCount(list.length);
      })
      .catch(() => {
        /* 读不到（后端不可达）就不显示计数徽章——不摆假数字 */
      });
    return () => {
      alive = false;
    };
  }, []);

  // 清空记录的唯一实现在 RcHistoryClearButton（RcPageHistory 导出）——本页只传
  // 清空后的计数归零回调（2026-09-27 审计收口：确认文案/失败 toast 原先两处各写一份）。
  return (
    <div className={styles.pageWrap} role="region" aria-label="设置">
      <section className={styles.setCard}>
        <h3 className={styles.setSecTitle} id="rc-set-general">
          通用
        </h3>
        <div className={styles.setRow}>
          <div className={styles.setRowInfo}>
            <div className={styles.setRowTitle}>默认发起方式</div>
            <div className={styles.setRowHint}>
              未记住连接方式的设备使用此默认值；连接时可选择「只看」或「连接并控制」
            </div>
          </div>
          <RcSettingsChoiceTags
            label="默认发起方式"
            value={cap}
            options={
              [
                { key: "view", label: "只看", tip: "更安全：对方屏幕可见但不可操作" },
                { key: "control", label: "可控" },
              ] as const
            }
            onPick={onSetDefaultCap}
          />
        </div>
        <div className={styles.setRow}>
          <div className={styles.setRowInfo}>
            <div className={styles.setRowTitle}>启动工作台时自动开启远程通道</div>
            <div className={styles.setRowHint}>关闭后，主动连接设备时仍会自动开启；接收连接前请手动开启</div>
          </div>
          <span className={autoChannel ? styles.selfChipOn : styles.selfChipOff}>{autoChannel ? "已开" : "关"}</span>
          <button
            type="button"
            role="switch"
            aria-checked={autoChannel}
            aria-label="启动工作台时自动开启远程通道"
            className={`${settings.sToggle} ${autoChannel ? settings.on : settings.off}`}
            onClick={() => {
              const v = !autoChannel;
              setAutoChannel(v);
              writeAutoStartChannel(v);
            }}
          >
            <span className={settings.sToggleThumb} />
            <span className={settings.sToggleLabel}>{autoChannel ? "开" : "关"}</span>
          </button>
        </div>
        <RcReceiveDirectorySetting toast={toast} />
      </section>

      <section className={styles.setCard}>
        <h3 className={styles.setSecTitle} id="rc-set-security">
          安全
        </h3>
        <div className={styles.setRow}>
          <div className={styles.setRowInfo}>
            <div className={styles.setRowTitle}>被控能力上限</div>
            <div className={styles.setRowHint}>别人远程这台电脑时最高能申请到的档；「可控」包含只看</div>
          </div>
          <RcSettingsChoiceTags
            label="被控能力上限"
            value={rc.status?.capability ?? "view"}
            options={
              [
                { key: "view", label: "只看" },
                { key: "control", label: "可控（含只看）" },
              ] as const
            }
            disabled={rc.busy}
            onPick={(k) => void rc.setCapability(k)}
          />
        </div>
        <div className={styles.setRow}>
          <div className={styles.setRowInfo}>
            <div className={styles.setRowTitle}>免确认设备</div>
            <div className={styles.setRowHint}>
              <span className={styles.cntBadge}>{trustedCount} 台</span>
              对这些设备跳过本机确认；可在设备详情页「管理此设备」里随时关闭
            </div>
          </div>
          <button type="button" className={styles.miniBtn} onClick={onManageTrusted}>
            管理
          </button>
        </div>
        <div className={styles.setRow}>
          <div className={styles.setRowInfo}>
            <div className={styles.setRowTitle}>系统级组合键</div>
            <div className={styles.setRowHint}>
              出于系统安全，Ctrl+Alt+Del 等系统级组合键无法远程发送；需要时请让对方在现场按键
            </div>
          </div>
        </div>
      </section>

      <section className={styles.setCard}>
        <h3 className={styles.setSecTitle} id="rc-set-unattended">
          无人值守
        </h3>
        <div className={styles.setRow}>
          <div className={styles.setRowInfo}>
            <div className={styles.setRowTitle}>无人值守码</div>
            <div className={styles.setRowHint}>
              对方不在电脑前也能连进来：生成 15 分钟单次码或 24 小时码，可指定只看或可控
            </div>
          </div>
          <button type="button" className={styles.miniBtn} disabled={rc.busy} onClick={() => onOpenUno("unoGenerate")}>
            生成无人值守码
          </button>
        </div>
        <div className={styles.setRow}>
          <div className={styles.setRowInfo}>
            <div className={styles.setRowTitle}>固定密码</div>
            <div className={styles.setRowHint}>
              适合长期无人值守的电脑：知道密码即可申请连接；连续输错 5 次后暂停尝试 10 分钟
            </div>
          </div>
          <span className={rc.status?.uno_pass ? styles.selfChipOn : styles.selfChipOff}>
            {rc.status?.uno_pass ? "已开启" : "未开启"}
          </span>
          <button type="button" className={styles.miniBtn} disabled={rc.busy} onClick={() => onOpenUno("unoPass")}>
            {rc.status?.uno_pass ? "管理" : "设置密码"}
          </button>
        </div>
      </section>

      <section className={styles.setCard}>
        <h3 className={styles.setSecTitle} id="rc-set-data">
          数据
        </h3>
        <div className={styles.setRow}>
          <div className={styles.setRowInfo}>
            <div className={styles.setRowTitle}>会话记录</div>
            <div className={styles.setRowHint}>
              {historyCount !== null && <span className={styles.cntBadge}>{historyCount} 条</span>}
              只记元数据（时间 / 时长 / 结果），不含画面与键鼠 · 上限 20 条
            </div>
          </div>
          <button type="button" className={styles.miniBtn} onClick={onNavigateHistory}>
            查看记录
          </button>
        </div>
        <div className={styles.setRow}>
          <div className={styles.setRowInfo}>
            <div className={styles.setRowTitle}>清空会话记录</div>
            <div className={styles.setRowHint}>只删除会话记录，不影响配对设备；清空后不可恢复</div>
          </div>
          <RcHistoryClearButton rc={rc} onCleared={() => setHistoryCount(0)} label="清空" withIcon={false} />
        </div>
      </section>

      <div className={styles.setFoot}>
        <button type="button" className={styles.linkBtn} onClick={onOpenSettings}>
          更多远程设置在主窗口 →（主窗口设置页 ·「远程电脑」分区）
        </button>
      </div>
    </div>
  );
}
