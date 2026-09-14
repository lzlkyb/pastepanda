import { useState } from "react";
import { useKbSync, type KbDevice } from "@/hooks/useKbSync";
import { fingerprintOf } from "@/lib/fingerprint";
import {
  countKbOnline, isKbDeviceOnline, kbOnlineLabel, kbDeviceProblem, hasKbRelayPeer,
} from "@/lib/kbOnline";
import type { ToastFn } from "@/components/Toast";
import { KbPairDialog } from "./KbPairDialog";
import { KbJoinRequests, type KbJoinProps } from "./KbJoinRequests";
import styles from "../Settings.module.css";

/**
 * 开始提示星型配对的对端数阈值。
 *
 * 本机有 4 个对端 = 至少 5 台设备，对应规划里那个「>4 台」。
 *
 * ❗ 看的是**本机的对端数**而不是总台数，因为成本就是按对端算的：
 * 每多一个直连对端，后端就多跑一条 `peer_loop`。
 */
const STAR_HINT_PEERS = 4;

/** 「12 秒前」这种相对时间。0 = 从未同步过。 */
function ago(ms: number): string {
  if (!ms) return "还没同步过";
  const d = Date.now() - ms;
  if (d < 0) return "刚刚";
  if (d < 60_000) return `${Math.floor(d / 1000)} 秒前同步`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前同步`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前同步`;
  return `${Math.floor(d / 86_400_000)} 天前同步`;
}

/**
 * 「知识库同步」开关下面那块面板。
 *
 * 结构照 `LanSyncPanel`（同一套 `styles.lanPanel` 类），因为它就是同一种东西：
 * 一个开关下面挂设备列表。用户在设置页里看到两块长得一样的，
 * 正好对上「一个同步剪贴板、一个同步笔记」。
 */
export function KbSyncPanel({ toast }: {
  toast: ToastFn;
}) {
  const s = useKbSync(true, toast);
  // 不再区分 create/paste：角色判断推迟到向导里（而且剪贴板里已有码时会自动跳过）
  const [pairOpen, setPairOpen] = useState(false);
  const [confirmForget, setConfirmForget] = useState<KbDevice | null>(null);

  // ❗ 不能只看 `s.live`（组播听得见）——理由见 `@/lib/kbOnline` 文件头。
  const online = countKbOnline(s.devices, s.live);
  const fp = s.identity?.fingerprint ?? "读取中…";

  /** 一份，两处用：面板自己一份，配对向导的等待屏一份（弹窗盖住面板时看不到下面那份）。 */
  const joins: KbJoinProps = {
    pending: s.pending,
    busy: s.busy,
    onApprove: s.approveJoin,
    onDeny: s.denyJoin,
  };

  return (
    <div className={styles.lanPanel}>
      <div className={styles.lanPanelHeader}>
        <div className={styles.lanStatus}>
          {/* 点跟随真实状态：一台都不在线就是灰的，不恒亮假绿（LanSyncPanel 改过这个） */}
          <div className={`${styles.lanDot}${online === 0 ? ` ${styles.off}` : ""}`} />
          <span className={styles.lanStatusText}>
            {s.devices.length === 0
              ? "还没有配对任何设备"
              : `${s.devices.length} 台设备已配对，${online} 台在线`}
          </span>
        </div>
        {s.devices.length > 0 && (
          <button className={styles.lanRefreshBtn} onClick={() => s.refreshDevices()} disabled={s.busy}>
            🔄 刷新
          </button>
        )}
      </div>

      <div style={{ fontSize: 12, color: "var(--text-secondary)", marginBottom: 12 }}>
        笔记<b>只在你的设备之间直连传输</b>，不经过任何服务器。
      </div>

      {/* 🔴 摆在最上面：它是本面板里唯一**需要用户现在就做一件事**的块。
          没人敲门时组件自己返 null，不占位。 */}
      <KbJoinRequests {...joins} />

      {s.devices.length === 0 ? (
        <>
          {/* ❗ 身份没读到时禁用：弹窗本身需要 `identity.fingerprint`，
              不禁的话点下去**什么都不会发生**（规则 #15.3）。
              读失败的原因 refreshIdentity 已经弹过 toast 了。 */}
          {/* 一个按钮而不是两个：两台都是用户自己的机器，他心里只有
              「把它俩连起来」，并排两个入口是在逼他先判断自己是哪一方。 */}
          {/* 🔴 指纹必须排在这个按钮**下面**，且不给复制按钮。
              改之前它在上面，15px 加粗 + 字距 2 + 一个「📋 复制」——
              是本面板里最显眼、也是第一个能复制的东西。
              结果用户直接把**指纹**当邀请码发给了对面（2026-09-06 真实反馈）。
              一个带复制按钮的串放在主流程上，就是在邀请用户把它发出去。 */}
          <button className={styles.lanTestBtn} style={{ width: "100%" }}
            disabled={!s.identity} onClick={() => setPairOpen(true)}>
            ＋ 添加设备
          </button>
          <div style={{ marginTop: 12, fontSize: 11, color: "var(--text-muted)", lineHeight: 1.7 }}>
            本机指纹{" "}
            <span style={{
              fontFamily: "ui-monospace, Consolas, monospace",
              fontWeight: 700, color: "var(--text-secondary)",
            }}>{fp}</span>
            <br />
            这<b>不是邀请码</b>，不用发给别人。配对时对方会念出一串数字跟你对，那时才用得上。
          </div>
        </>
      ) : (
        <>
          <div className={styles.lanDeviceList}>
            {s.devices.map((d) => {
              const isOnline = !d.paused && isKbDeviceOnline(d, s.live);
              const problem = d.paused ? null : kbDeviceProblem(d, s.last, s.live);
              return (
                <div
                  key={d.node_id}
                  className={`${styles.lanDeviceItem}${d.paused ? ` ${styles.lanDevicePaused}` : ""}`}
                >
                  <div
                    className={styles.lanDeviceAvatar}
                    style={{
                      background: `hsl(${(d.node_id.charCodeAt(0) || 0) * 40 % 360}, 60%, 55%)`,
                      opacity: d.paused ? 0.55 : 1,
                    }}
                  >
                    {d.name.charAt(0).toUpperCase()}
                  </div>
                  <div className={styles.lanDeviceInfo}>
                    <div className={styles.lanDeviceName}>{d.name}</div>
                    <div className={styles.lanDeviceTime}>
                      {fingerprintOf(d.node_id)} · {d.paused ? "已暂停" : ago(d.last_seen)}
                    </div>
                    {/* 🔴 离线时把**原因**说出来。后端一直算好了放在 `last[].error` 里，
                        而这个面板从来没渲染过它——于是「对方还没把这台加回去」这种
                        完全可操作的原因，在界面上只表现为一个字「离线」。 */}
                    {problem && (
                      <div className={styles.lanDeviceTime}
                        style={{ color: "var(--orange)", whiteSpace: "normal", lineHeight: 1.5 }}>
                        {problem}
                      </div>
                    )}
                  </div>
                  {d.paused ? (
                    <span className={styles.lanDevicePausedBadge} title="不会主动拨它，也会拒它的入站同步">
                      已暂停
                    </span>
                  ) : (
                    <span style={{
                      fontSize: 10, padding: "2px 7px", borderRadius: 20,
                      background: isOnline ? "var(--green-bg)" : "var(--card-bg)",
                      color: isOnline ? "var(--green)" : "var(--text-secondary)",
                      border: `1px solid ${isOnline ? "var(--green-border)" : "var(--border-color)"}`,
                    }}>
                      {kbOnlineLabel(d, s.live)}
                    </span>
                  )}
                  <div className={styles.lanPauseSw}>
                    <span className={styles.lanPauseLabel}>启用</span>
                    <button
                      type="button"
                      role="switch"
                      aria-checked={!d.paused}
                      aria-label={d.paused ? "启用与该设备的同步" : "暂停与该设备的同步"}
                      className={`${styles.lanPauseToggle}${d.paused ? "" : ` ${styles.on}`}`}
                      disabled={s.busy}
                      onClick={async () => {
                        try {
                          await s.setPaused(d.node_id, !d.paused);
                          toast(
                            d.paused
                              ? `已恢复「${d.name}」的同步`
                              : `已暂停「${d.name}」——不再与它同步，配对与游标都还在`,
                            "success",
                          );
                        } catch (e) {
                          toast(
                            `${d.paused ? "恢复" : "暂停"}失败：${e instanceof Error ? e.message : String(e)}`,
                            "error",
                          );
                        }
                      }}
                      title={d.paused ? "恢复同步（无需重新配对）" : "暂停同步（可随时恢复）"}
                    >
                      <span className={styles.lanPauseKnob} />
                    </button>
                  </div>
                  <button className={styles.lanRefreshBtn} disabled={s.busy || d.paused}
                    title={d.paused ? "已暂停" : "立刻同步"}
                    onClick={() => s.syncNow(d.node_id)}>⇅</button>
                  <button className={styles.lanRefreshBtn} disabled={s.busy}
                    style={{ color: "var(--danger)" }}
                    title="从本机删除，需重新配对"
                    onClick={() => setConfirmForget(d)}>删除</button>
                </div>
              );
            })}
          </div>
          {/* ❗ 不是错误提示（异地设备本来就只能走中继），所以用中性颜色、不报警。
              但必须说：两台本该在同一局域网时，这意味着笔记在绕一趟国外的公共中继，
              而界面上原本零线索。 */}
          {hasKbRelayPeer(s.devices, s.live) && (
            <div style={{
              marginTop: 10, fontSize: 11, lineHeight: 1.7,
              color: "var(--text-muted)",
            }}>
              标「绕中继」的设备，笔记在绕一趟<b>国外的公共中继</b>。
              异地设备本该如此；但如果两台就在同一个局域网，说明打洞
              被防火墙或 AP 隔离挡住了（发现包走 UDP 5008），会慢很多。
            </div>
          )}

          {/* 设备多了之后的拓扑引导。

              🔴 后端本来就支持星型——`peer_loop` 是按**已配对设备**起的，
              所以拓扑就是配对图，星型是「配出来」的而不是「写出来」的。
              缺的一直只是**没人告诉用户还有这个选项**，于是默认就配成了全互配。

              ❗ **不能写成「你配错了」**：面板只知道本机自己的对端数，
              看不到全局拓扑——而星型里的那台常开机**同样**有 N-1 个对端，
              它才是配对了的那一台。所以最后一句要给它留个口子。 */}
          {s.devices.length >= STAR_HINT_PEERS && (
            <div style={{
              marginTop: 10, fontSize: 11, lineHeight: 1.7,
              color: "var(--text-muted)",
            }}>
              这台设备正在<b>直接对接 {s.devices.length} 台</b>。设备一多时，
              建议配成「星型」：让其它设备<b>都只跟一台常开机配对</b>，彼此之间不配。
              不用改任何设置——在各台设备上把多余的配对「删除」掉、
              只留跟常开机的那一条即可；
              {s.devices.length + 1} 台设备两两互配是 {(s.devices.length + 1) * s.devices.length / 2} 对连接，
              星型只需 {s.devices.length} 对。
              <br />
              ⚠ 代价：那台常开机掉线时，其它设备之间就同步不了了
              （两两互配是少一台只少一条路）。
              <b>如果这台就是你的常开机，那现在这样就是对的。</b>
            </div>
          )}

          <div style={{
            marginTop: 12, paddingTop: 11, borderTop: "1px solid var(--border-color)",
            display: "flex", justifyContent: "space-between", alignItems: "center",
          }}>
            <span style={{ fontSize: 11, color: "var(--text-muted)" }}>本机指纹 {fp}</span>
            <button className={styles.lanRefreshBtn} disabled={!s.identity}
              onClick={() => setPairOpen(true)}>＋ 添加设备</button>
          </div>
        </>
      )}

      {pairOpen && s.identity && (
        <KbPairDialog
          myFingerprint={s.identity.fingerprint}
          myNodeId={s.identity.node_id}
          defaultName={s.identity.device_name}
          devices={s.devices}
          joins={joins}
          onClose={() => setPairOpen(false)}
          onCreateInvite={s.createInvite}
          onPreview={s.previewInvite}
          onPair={s.pair}
          toast={toast}
        />
      )}

      {confirmForget && (
        <div className="dialog-backdrop" onClick={() => setConfirmForget(null)}>
          <div className="dialog-box dialog-solid w420" onClick={(e) => e.stopPropagation()}>
            <div className="dialog-header"><h2 className="dialog-title">删除「{confirmForget.name}」？</h2></div>
            <div className="dialog-body" style={{ fontSize: 12.5, lineHeight: 1.7 }}>
              <p style={{ margin: "0 0 8px" }}>
                本机不再与它同步，已同步过来的笔记<b>不会被删</b>；要恢复得重新配对。
              </p>
              <p style={{ margin: "0 0 8px", color: "var(--text-muted)" }}>
                若只想暂时不同步，用旁边的「启用」开关即可，无需删除。
              </p>
              {/* 说清后果：只删一边的话对方会一直白拨，用户看到「连不上」会以为是 bug */}
              <p style={{ margin: 0, color: "var(--text-muted)" }}>
                ❗ 对方那台机器上<b>还留着这台的记录</b>，它会继续尝试连接并被拒绝。
                想彻底断开，请在两边都删除一次。
              </p>
            </div>
            <div className="dialog-footer">
              <button className="btn-secondary" onClick={() => setConfirmForget(null)}>取消</button>
              <button className="btn-danger" disabled={s.busy} onClick={async () => {
                await s.forget(confirmForget.node_id);
                toast(`已删除「${confirmForget.name}」`, "success");
                setConfirmForget(null);
              }}>删除此设备</button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
