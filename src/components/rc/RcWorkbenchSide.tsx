/**
 * RcWorkbenchSide — 工作台左栏：配置与设备，全部是「发起前」的事。
 *
 * 从 RemoteComputerDialog 拆出来的布局半区（2A 配套，2026-09-18）。
 * v5（design/远程电脑-v5-沉浸工作台-设计稿.html 原则②「少边框多分组」）：
 * 四张卡收敛为两张——
 *   「连接」卡 = 允许被远程开关 + 被控画质/采集范围（RcQualityBar）；
 *   「我的设备」卡 = 列表 + 配对行 + 一次性协助降级为卡底 ghost 按钮行
 *   （低频入口不配拥有一张卡）。
 *
 * 职责边界：这里只管「你去控别人」；被控确认横幅 / 入站申请留在主窗口
 * （被动事件必须主窗常驻，人不在工作台时也得看得见）。
 */
import { ChevronLeft, Plus, Server, ShieldCheck } from "lucide-react";
import type { RcCapability } from "@/lib/api/rc";
import { rcDeviceRename } from "@/lib/api/rc";
import type { UseRc } from "@/hooks/useRc";
import { useToast } from "@/components/Toast";
import { RcQualityBar } from "./RcQualityBar";
import { RcDeviceList } from "./RcDeviceList";
import styles from "./RemoteComputer.module.css";
import settingsToggle from "@/components/Settings.module.css";

export function RcWorkbenchSide({
  rc,
  rcEnabledSelf,
  cap,
  lastPeer,
  probing,
  channelUp,
  hasTargets,
  locked,
  lockedLabel,
  toast,
  onToggleSelf,
  onPair,
  onProbe,
  onStartChannel,
  onRequest,
  onRequestWith,
  onForget,
  onHelpMe,
  onHelpOther,
  onCollapse,
}: {
  rc: UseRc;
  /** 本机「允许被远程」当前状态（来自后端 `rc_status.enabled`，见 RcWorkbench 的说明） */
  rcEnabledSelf: boolean;
  cap: RcCapability;
  lastPeer: string | null;
  probing: boolean;
  channelUp: boolean;
  hasTargets: boolean;
  /**
   * 有会话进行中（任意非 idle）。后端只有一个会话位：此时任何「发起」都会
   * 被 `busy_local` 拒——按钮必须锁住，否则就是摆一个点了必失败的死项。
   */
  locked: boolean;
  /** 锁定的原因（「对方正在远程本机」/「已有申请在等对方同意」…），显示给用户。 */
  lockedLabel: string;
  onToggleSelf: (v: boolean) => void;
  /** 设备行菜单的错误提示用（RcDeviceList 必填）；类型与 useToast 的 toast 一致 */
  toast: ReturnType<typeof useToast>["toast"];
  onPair: () => void;
  onProbe: () => void;
  /** 开启远程通道（成功 toast 由调用方负责——它要等 Promise 结果） */
  onStartChannel: () => void;
  onRequest: (id: string) => void;
  onRequestWith: (id: string, c: RcCapability) => void;
  onForget: (id: string) => Promise<boolean>;
  /** 方案甲：被协助方——出码让对方连一次（用完即忘）。 */
  onHelpMe: () => void;
  /** 方案甲：协助方——粘对方的码直接连，跳过配对完成屏。 */
  onHelpOther: () => void;
  /**
   * 会话进行中「把侧栏收回 52px 轨」的出口（方案 B）。不传 = 不摆收起按钮
   * （没有画面对侧栏宽度敏感时，收起是个没有收益的动作）。
   */
  onCollapse?: () => void;
}) {
  return (
    <aside className={styles.wbSide}>
      {/* v4 对稿：稿的左列**直接是三张卡**，没有「设置与设备」小标题行——
          平时不渲染；只挂会话中的「收起」钮（有画面可让时才需要出口）。 */}
      {onCollapse && (
        <div className={styles.wbSideHead}>
          <span className={styles.meta}>设置与设备</span>
          <span className={styles.wbSideHeadSp} />
          <button
            type="button"
            className={styles.railBtn}
            title="收起侧栏，把宽度让给画面"
            aria-label="收起侧栏"
            onClick={onCollapse}
          >
            <ChevronLeft size={16} />
          </button>
        </div>
      )}

      {/* v5 卡一「连接」：开关 + 本机画质/范围同住一张卡（原则②少边框多分组）。
          开关本体沿用设置页同款 .sToggle——同一控件两处长相必须一致。 */}
      <div className={styles.card}>
        <div className={styles.cardTitle}>
          <ShieldCheck size={14} aria-hidden="true" />
          连接
          <span className={styles.cardTitleSp} />
          <span className={rcEnabledSelf ? styles.selfChipOn : styles.selfChipOff}>
            {rcEnabledSelf ? "可被远程" : "不可被远程"}
          </span>
        </div>
        <div className={styles.selfRow}>
          <div className={styles.selfRowInfo}>
            <div className={styles.selfRowTitle}>允许别人连接这台电脑</div>
            <div className={styles.selfRowHint}>只影响别人控你；发起远程不需要打开它</div>
          </div>
          <span className={styles.selfRowSp} />
          <button
            type="button"
            role="switch"
            aria-checked={rcEnabledSelf}
            aria-label="允许被远程"
            disabled={rc.busy}
            className={`${settingsToggle.sToggle} ${rcEnabledSelf ? settingsToggle.on : settingsToggle.off}`}
            onClick={() => onToggleSelf(!rcEnabledSelf)}
          >
            <span className={settingsToggle.sToggleThumb} />
            <span className={settingsToggle.sToggleLabel}>{rcEnabledSelf ? "开" : "关"}</span>
          </button>
        </div>
        <RcQualityBar
          rc={rc}
          quality={rc.status?.quality ?? "auto"}
          captureScope={rc.status?.capture_scope ?? "virtual"}
          // 会话里也有一条画质条，但那条**立即作用于对方**；这一条写的是本机配置。
          // 档位名一模一样，必须就地说明作用对象，否则用户以为在调对方的画质。
          localNote="本机被控画面 · 别人看你时用它"
        />
      </div>

      <div className={styles.card}>
        {/* v4 对稿：卡标题「我的设备 + 计数徽章 + 检测在线」（A2/C 窗同构），
            「检测在线」从底部按钮排提升到标题位——它是这一卡的全局动作。 */}
        <div className={styles.cardTitle}>
          <Server size={14} aria-hidden="true" />
          我的设备
          <span className={styles.cardTitleN}>{rc.targets.length}</span>
          <span className={styles.cardTitleSp} />
          <button
            type="button"
            className={styles.linkBtn}
            disabled={probing}
            title="对非「在线」设备短超时探测一次（打开工作台时也会自动探）"
            onClick={onProbe}
          >
            {probing ? "检测中…" : "检测在线"}
          </button>
        </div>
        {locked && <div className={styles.lockNote}>{lockedLabel} · 设备操作暂时锁定</div>}

        {!hasTargets ? (
          // 空态的**完整版**（图标 + 标题 + 三步 + 主按钮）归主区，那里有横向空间。
          // 这里原来复用同一个组件（compact），结果同一个标题、同一个配对按钮
          // 在侧栏和主区各出现一次 —— 精简成一句「下一步做什么」+ 一个小按钮。
          <div className={styles.emptyHint}>
            <div className={styles.emptyHintTitle}>还没有可远程的设备</div>
            <div className={styles.emptyHintBody}>
              完成一次远程配对，设备会出现在这里。
            </div>
            <button type="button" className={styles.miniBtn} onClick={onPair}>
              ＋ 配对一台
            </button>
          </div>
        ) : !channelUp ? (
          <div className={styles.noteWarn}>
            已配对 {rc.targets.length} 台，但远程通道未启动。
            <div className={styles.mt10}>
              <button
                type="button"
                className={styles.miniBtnPri}
                disabled={rc.busy}
                // 🔴 这里必须是 onStartChannel，不是 onProbe。probeTargets 在通道未启动时
                //    只 refreshTargets 就返回——按钮点了毫无反应（拆组件时丢的回归）。
                onClick={onStartChannel}
              >
                开启远程通道
              </button>
              <button type="button" className={`${styles.miniBtn} ${styles.ml8}`} onClick={onPair}>
                再配对一台
              </button>
            </div>
          </div>
        ) : (
          <>
            <RcDeviceList
              targets={rc.targets}
              lastPeer={lastPeer}
              deviceDeny={rc.status?.device_deny ?? {}}
              busy={rc.busy}
              locked={locked}
              lockedLabel={lockedLabel}
              requestCap={cap}
              onRequest={onRequest}
              onRequestWith={onRequestWith}
              onForget={onForget}
              onSetAllowed={async (id, allowed) => rc.setDeviceAllowed(id, allowed)}
              // A1：免确认直连（方案 D 能力）直接复用 store 的 setDeviceTrust；
              // 它走 run()，失败会落到工作台的错误行，与「禁止/允许」同一套反馈。
              onTrustToggle={async (id, trusted) => rc.setDeviceTrust(id, trusted)}
              onRename={async (id, note) => {
                try {
                  await rcDeviceRename(id, note);
                  await rc.refreshTargets();
                  return true;
                } catch (e) {
                  toast(String(e), "error");
                  return false;
                }
              }}
              onPair={onPair}
              toast={toast}
            />
            {/* v4 对稿：稿式 pairRow——虚线分隔 + 居中文字链（A2 窗「配对一台新设备」）。
                原 recentRow 的「＋ 再配对一台」与此重复，已并到这里。 */}
            <div className={styles.pairRow}>
              <button type="button" className={styles.linkBtn} onClick={onPair}>
                <Plus size={12} strokeWidth={2.2} aria-hidden="true" />
                配对一台新设备
              </button>
            </div>
          </>
        )}
        {/* v5：一次性协助（方案甲）从独立卡降级为卡底 ghost 行（原则②——
            低频入口不占一张卡）。会话中一并锁住：后端只有一个会话位。
            title 就地说明代价：用完即弃，不留双方列表。 */}
        <div className={styles.ctlDiv} />
        <div className={styles.adhocBtns}>
          <button
            type="button"
            className={styles.ghostBtn}
            disabled={locked}
            title="出码让对方连一次 · 用完即弃，不留双方设备列表"
            onClick={onHelpMe}
          >
            让别人帮我
          </button>
          <button
            type="button"
            className={styles.ghostBtn}
            disabled={locked}
            title="粘对方的码直接连 · 用完即弃，不留双方设备列表"
            onClick={onHelpOther}
          >
            帮别人连一次
          </button>
        </div>
      </div>
    </aside>
  );
}
