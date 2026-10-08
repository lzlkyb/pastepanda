import { useEffect, useState } from "react";
import { ChevronRight, RefreshCw, ShieldCheck } from "lucide-react";
import { MobileSheet } from "../ui/MobileSheet";
import { MobileNotice } from "../ui/MobileNotice";
import { useKnowledgeSync } from "./useKnowledgeSync";
import type { KbDevice } from "@/hooks/useKbSync";
import ui from "../ui/MobileUi.module.css";
import styles from "./KnowledgeSync.module.css";

export function KnowledgeSync({ active, onChanged }: { active: boolean; onChanged?: () => void }) {
  const sync = useKnowledgeSync(active, onChanged);
  const [open, setOpen] = useState(false);
  const [selected, setSelected] = useState("");
  const [consent, setConsent] = useState(false);
  const [revoking, setRevoking] = useState<KbDevice | null>(null);
  useEffect(() => {
    if (!active) setOpen(false);
  }, [active]);
  const candidate = sync.offers.find((o) => o.node_id === selected);
  const blocked = sync.devices.length > 0;
  const status = !sync.ready
    ? "同步状态待确认"
    : blocked
      ? sync.enabled
        ? "已授权知识库同步"
        : "同步已关闭 · 内容保留在手机"
      : "仅本机使用 · 可授权电脑同步";
  const feedback = sync.feedback;
  return (
    <div className={styles.host}>
      <button type="button" className={styles.entry} onClick={() => setOpen(true)}>
        <ShieldCheck size={18} aria-hidden="true" />
        <span>{status}</span>
        <span className={styles.entryLabel}>同步</span>
        <ChevronRight size={18} aria-hidden="true" />
      </button>
      {active && feedback && !open && <MobileNotice compact {...feedback} onDismiss={sync.busy ? undefined : sync.dismissFeedback} />}
      <MobileSheet
        open={open}
        onClose={() => setOpen(false)}
        title="知识库同步"
        description="阅读和新建先保存在手机。知识库授权与远控配对相互独立。"
        footer={feedback ? <MobileNotice compact {...feedback} onDismiss={sync.busy ? undefined : sync.dismissFeedback} /> : undefined}
      >
        <div className={styles.panel}>
          {!sync.ready && (
            <MobileNotice
              tone="warning"
              title="尚未取得同步状态"
              detail="暂不允许新增授权，避免把不同电脑的资料合并。"
            />
          )}
          <div className={styles.actions}>
            <button type="button" className={ui.secondary} disabled={!!sync.busy} onClick={() => void sync.retry()}>
              <RefreshCw size={18} aria-hidden="true" />
              刷新状态
            </button>
            {blocked && (
              <button
                type="button"
                className={ui.secondary}
                disabled={!!sync.busy || sync.enabled === null}
                onClick={() => void sync.toggle(!sync.enabled)}
              >
                {sync.enabled ? "关闭同步" : "开启同步"}
              </button>
            )}
          </div>
          {sync.devices.length > 1 && (
            <MobileNotice
              tone="warning"
              title="已有多台授权设备"
              detail="当前协议不能确认它们属于同一个库，资料可能合并。手机首版暂不新增电脑，可暂停或撤销现有授权。"
            />
          )}
          {sync.devices.map((device) => {
            const report = sync.last.find((r) => r.peer === device.node_id);
            return (
              <section key={device.node_id} className={styles.device}>
                <h3>{device.name || "已授权电脑"}</h3>
                <p>{device.paused ? "已暂停后续同步" : sync.enabled ? "等待或进行设备同步" : "同步开关已关闭"}</p>
                <p>
                  身份：<code>{device.node_id}</code>
                </p>
                <p>
                  最后成功同步：{report?.last_ok_ms ? new Date(report.last_ok_ms).toLocaleString() : "尚无成功记录"}
                </p>
                {report && (
                  <div className={styles.report}>
                    <p>
                      最近报告：新增 {report.created} · 更新 {report.updated} · 删除 {report.deleted}
                    </p>
                    {!!report.missing_files && <p>未收到笔记文件：{report.missing_files}</p>}
                    {!!report.import_failed && <p>笔记导入失败：{report.import_failed}</p>}
                    {!!report.assets_skipped && (
                      <p>本机未能发出的图片：{report.assets_skipped}（原图缺失或超过限制）</p>
                    )}
                    {!!report.conflicts && <p>本轮冲突副本：{report.conflicts}；内容已保留，请到电脑处理。</p>}
                    {!!report.skipped_older && <p>较旧版本未采纳：{report.skipped_older}</p>}
                    {!!report.clock_too_far_ahead_ms && <p>电脑时间偏差过大，请校准两端时间。</p>}
                    {!!report.diverged_buckets && <p>正在修复资料差异：{report.diverged_buckets} 组</p>}
                    {!!report.fails && (
                      <MobileNotice
                        compact
                        tone="warning"
                        title="最近同步未成功"
                        detail="电脑可能离线、同步未开启或授权未确认。本机内容可以继续使用。"
                      />
                    )}
                  </div>
                )}
                <div className={styles.actions}>
                  <button
                    type="button"
                    className={ui.secondary}
                    disabled={!!sync.busy || !sync.enabled || device.paused}
                    onClick={() => void sync.sync(device)}
                  >
                    立即同步
                  </button>
                  <button
                    type="button"
                    className={ui.secondary}
                    disabled={!!sync.busy && !(sync.busy === "sync" && sync.syncingPeer === device.node_id)}
                    onClick={() => void (sync.busy === "sync" ? sync.cancel(device) : sync.pause(device))}
                  >
                    {device.paused ? "恢复同步" : "取消并暂停同步"}
                  </button>
                  <button
                    type="button"
                    className={ui.textButton}
                    disabled={!!sync.busy}
                    onClick={() => setRevoking(device)}
                  >
                    撤销授权
                  </button>
                </div>
              </section>
            );
          })}
          {sync.conflict_backlog > 0 && (
            <MobileNotice
              tone="warning"
              title={`本机有 ${sync.conflict_backlog} 份待处理冲突副本`}
              detail="保留两版内容，不自动覆盖。首版请到电脑查看与处理。"
            />
          )}
          {revoking && (
            <section className={styles.consent}>
              <h3>撤销 {revoking.name || "这台电脑"} 的知识库授权？</h3>
              <p>保留手机笔记与草稿，只停止之后的同步。已经保存到电脑的内容不会被清除。</p>
              <div className={styles.actions}>
                <button type="button" className={ui.secondary} disabled={!!sync.busy} onClick={() => setRevoking(null)}>
                  保留授权
                </button>
                <button
                  type="button"
                  className={ui.primary}
                  disabled={!!sync.busy}
                  onClick={async () => {
                    if (await sync.revoke(revoking)) setRevoking(null);
                  }}
                >
                  撤销并保留本机内容
                </button>
              </div>
            </section>
          )}
          {!blocked && (
            <section>
              <h3>从已配对电脑开启</h3>
              <p>远控配对不会自动共享笔记。选择电脑后，还需要确认知识库授权。</p>
              {sync.offers.length === 0 && <p>没有可授权的电脑。可先在“设备”中添加电脑；现在仍能新建本机笔记。</p>}
              {sync.offers.map((offer) => (
                <button
                  type="button"
                  key={offer.node_id}
                  className={styles.offer}
                  disabled={!sync.ready || !!sync.busy}
                  aria-pressed={selected === offer.node_id}
                  onClick={() => {
                    setSelected(offer.node_id);
                    setConsent(false);
                  }}
                >
                  <span>{offer.name || "已配对电脑"}</span>
                  <ChevronRight size={18} aria-hidden="true" />
                </button>
              ))}
              {candidate && (
                <div className={styles.consent}>
                  <h3>授权 {candidate.name || "这台电脑"}</h3>
                  <p>
                    电脑身份：<code>{candidate.node_id}</code>
                  </p>
                  <p>
                    范围为电脑与手机的<strong>整个当前知识库</strong>
                    ，会双向合并。本机已有笔记也会同步到电脑；不支持文件夹权限隔离。
                  </p>
                  <p>
                    当前无法预先取得电脑资料数量、图片体量和独立知识库身份。大库可能占用较多手机空间，请先在电脑确认要同步的资料。
                  </p>
                  <label className={styles.checkbox}>
                    <input
                      type="checkbox"
                      checked={consent}
                      disabled={!!sync.busy}
                      onChange={(event) => setConsent(event.target.checked)}
                    />
                    <span>我已核对电脑，并同意整个当前库双向同步</span>
                  </label>
                  <button
                    type="button"
                    className={ui.primary}
                    disabled={!consent || !!sync.busy || !sync.ready}
                    onClick={async () => {
                      if (await sync.authorize(candidate)) {
                        setSelected("");
                        setConsent(false);
                      }
                    }}
                  >
                    授权并开启同步
                  </button>
                </div>
              )}
            </section>
          )}
          <p>暂停会取消正在进行的同步，并停止后续同步。已经落盘的内容保留，不撤回已经传到电脑的内容。</p>
          <p>报告按设备与同步轮次记录，不提供单篇“电脑已收到”的保证。图片是否完整请以正文中的缺图提示为准。</p>
        </div>
      </MobileSheet>
    </div>
  );
}
