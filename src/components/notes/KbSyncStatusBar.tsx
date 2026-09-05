import { useState, useCallback, useEffect } from "react";
import { useWindowVisible } from "@/hooks/useWindowVisible";
import { logger } from "@/lib/logger";
import type { KbDevice, KbLastSync } from "@/hooks/useKbSync";

/** 「12 秒前」。 */
function ago(ms: number): string {
  const d = Date.now() - ms;
  if (d < 0) return "刚刚";
  if (d < 60_000) return `${Math.floor(d / 1000)} 秒前`;
  if (d < 3_600_000) return `${Math.floor(d / 60_000)} 分钟前`;
  if (d < 86_400_000) return `${Math.floor(d / 3_600_000)} 小时前`;
  return `${Math.floor(d / 86_400_000)} 天前`;
}

function mins(ms: number): string {
  const s = Math.round(ms / 1000);
  return s < 60 ? `${s} 秒` : `${Math.floor(s / 60)} 分 ${s % 60} 秒`;
}

/**
 * 知识库里那条同步状态 + 异常提示。
 *
 * # 🔴 为什么放在知识库而不是设置页
 *
 * AM-6 那条教训：**输出要去它被用的地方**。配对是一次性设置（留在设置页），
 * 而「有 3 处冲突副本」「对端时钟不对、你改的一直判输」是**日常要看的**，
 * 埋在设置页里没人看得见。
 *
 * # 这几条后端本来就在算
 *
 * `ApplyReport` 里的 `clock_too_far_ahead_ms` / `conflicts` / `skipped_older` /
 * `missing_files` 之前**只进日志**。不显示的话它们就是纯粹的静默数据损失（规则 #15.3）。
 */
export function KbSyncStatusBar({ enabled, onSearchConflicts }: {
  enabled: boolean;
  /** 点「查看」时跳到冲突副本的搜索。 */
  onSearchConflicts: () => void;
}) {
  const [devices, setDevices] = useState<KbDevice[]>([]);
  const [live, setLive] = useState<string[]>([]);
  const [last, setLast] = useState<KbLastSync[]>([]);
  const [backlog, setBacklog] = useState(0);
  const [dismissed, setDismissed] = useState<Record<string, boolean>>({});

  const refresh = useCallback(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const r = await invoke<{
        devices: KbDevice[]; live: string[]; last: KbLastSync[]; conflict_backlog: number;
      }>("kb_sync_devices");
      setDevices(r.devices);
      setLive(r.live);
      setLast(r.last);
      setBacklog(r.conflict_backlog);
    } catch (e) {
      // 这条只是提示：失败就不显示，不弹 toast——用户在看笔记，
      // 不该被一条后台轮询打断（设置面板那边已经会报了）
      logger.warn("读取同步状态失败", e);
    }
  }, []);

  const winVisible = useWindowVisible();
  useEffect(() => {
    if (!enabled || !winVisible) return;
    refresh();
    // 10 秒：这条只是提示，比设置面板的 5 秒更松，省一半空转（规则 #8）
    const t = setInterval(refresh, 10_000);
    return () => clearInterval(t);
  }, [enabled, winVisible, refresh]);

  if (!enabled || devices.length === 0) return null;

  const name = (peer: string) =>
    devices.find((d) => d.node_id === peer)?.name ?? peer.slice(0, 8);
  const newest = last.find((l) => l.fails === 0 && l.at_ms > 0);
  const onlineCount = devices.filter((d) => live.includes(d.node_id)).length;
  const skew = last.find((l) => l.clock_too_far_ahead_ms != null);
  const failing = last.filter((l) => l.fails > 0);
  const skipped = newest && newest.skipped_older > 0 ? newest : null;
  // 两者分开算：原因不同（没传到 vs 传到了写不进库），文案也不一样。
  // 但都属于「没落地」，后端都会把游标夹在它们前面、下一轮重来。
  const live0 = last.filter((l) => l.fails === 0);
  const lostFiles = live0.reduce((a, l) => a + l.missing_files, 0);
  const failedImports = live0.reduce((a, l) => a + l.import_failed, 0);

  const row = (key: string, tone: "warn" | "bad" | "info", body: React.ReactNode) => {
    if (dismissed[key]) return null;
    const color = tone === "bad" ? "var(--danger)"
      : tone === "warn" ? "var(--orange)" : "var(--text-secondary)";
    const bg = tone === "bad" ? "var(--red-bg)"
      : tone === "warn" ? "var(--orange-bg)" : "transparent";
    return (
      <div key={key} style={{
        display: "flex", alignItems: "flex-start", gap: 8, padding: "8px 14px",
        background: bg, borderTop: "1px solid var(--border-color)", fontSize: 12,
      }}>
        <div style={{ flex: 1, color }}>{body}</div>
        {/* 只压这一次，不写进配置：这些提示本来就该在问题解决后自己消失 */}
        <button onClick={() => setDismissed((d) => ({ ...d, [key]: true }))}
          title="本次不再提示" style={{
            border: "none", background: "transparent", cursor: "pointer",
            color: "var(--text-muted)", fontSize: 13, lineHeight: 1, padding: 0,
          }}>×</button>
      </div>
    );
  };

  return (
    <div style={{ borderBottom: "1px solid var(--border-color)", background: "var(--card-bg)" }}>
      <div style={{ display: "flex", alignItems: "center", gap: 9, padding: "9px 14px", fontSize: 12.5 }}>
        <span style={{
          width: 8, height: 8, borderRadius: "50%",
          background: onlineCount > 0 ? "var(--green)" : "var(--text-muted)",
        }} />
        <span style={{ flex: 1 }}>
          {newest
            ? <>已与 <b>{name(newest.peer)}</b> 同步 · {ago(newest.at_ms)}</>
            : <>已配对 {devices.length} 台 · {onlineCount > 0 ? "正在等下一轮" : "对方都不在线"}</>}
        </span>
        {/* 🔴 用真实的抖动值，**不要写死 30 秒**：实际间隔是 20~40 秒，
            写死了盯着表的人会觉得程序坏了 */}
        {newest && newest.next_in_secs > 0 && (
          <span style={{ color: "var(--text-muted)", fontSize: 11 }}>
            下次约 {newest.next_in_secs} 秒后
          </span>
        )}
      </div>

      {skew && row("skew", "bad", <>
        <b>{name(skew.peer)} 的系统时间比本机快 {mins(skew.clock_too_far_ahead_ms!)}</b>
        <div style={{ marginTop: 3, color: "var(--text-secondary)" }}>
          <b>你在这台机器上改的笔记会一直判输</b>——它的时间戳永远更大。
          请校准两台机器的系统时间，改完自动恢复。
        </div>
      </>)}

      {backlog > 0 && row("conflict", "warn", <>
        <b>有 {backlog} 处冲突副本还没处理</b>
        <div style={{ marginTop: 3, color: "var(--text-secondary)" }}>
          两台设备在同一段时间里各改了同一篇。<b>两个版本都留着了，没有丢。</b>{" "}
          <button onClick={onSearchConflicts} style={{
            border: "none", background: "transparent", padding: 0, cursor: "pointer",
            color: "var(--accent-strong)", fontSize: 12, textDecoration: "underline",
          }}>查看这 {backlog} 处 →</button>
        </div>
      </>)}

      {skipped && row("skipped", "info", <>
        最近一次有 <b>{skipped.skipped_older} 篇</b>以本机版本为准，对端那几篇更旧、已跳过。
      </>)}

      {lostFiles > 0 && row("truncated", "warn", <>
        <b>有 {lostFiles} 篇没传完</b>
        <div style={{ marginTop: 3, color: "var(--text-secondary)" }}>
          清单里说有、文件却没到，通常是网络抖了一下。下一轮会自动重来。
        </div>
      </>)}

      {failedImports > 0 && row("import-failed", "warn", <>
        <b>有 {failedImports} 篇没能存进来</b>
        <div style={{ marginTop: 3, color: "var(--text-secondary)" }}>
          文件收到了，但写入失败——最常见的原因是<b>单篇太大</b>（超过 10MB）。
          同步会一直重试这几篇，在它们进来之前更新的内容不会被跳过。
        </div>
      </>)}

      {failing.map((f) => row(`fail-${f.peer}`, "warn", <>
        <b>连不上 {name(f.peer)} · {f.next_in_secs} 秒后重试（第 {f.fails} 次）</b>
        <div style={{ marginTop: 3, color: "var(--text-secondary)" }}>
          对方可能没开机、不在同一网络，或没开这个开关。
          {f.error && <span style={{ color: "var(--text-muted)" }}>（{f.error}）</span>}
        </div>
      </>))}
    </div>
  );
}
