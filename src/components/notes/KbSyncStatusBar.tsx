import { useState, useCallback, useEffect } from "react";
import { create } from "zustand";
import { useWindowVisible } from "@/hooks/useWindowVisible";
import { logger } from "@/lib/logger";
import type { KbDevice, KbLastSync } from "@/hooks/useKbSync";
import { countKbOnline } from "@/lib/kbOnline";
import styles from "./KbSyncStatusBar.module.css";

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
 * 哪几条提示被按下了 ×。
 *
 * 🔴 不能用组件内的 `useState`：本组件只在**知识库模式**下挂着，
 * 切到其它模式就卸载——于是用户点的 × 切走再回来就白点了，
 * 而 `neverOk` 那一档要连续失败约 1.5 小时才进休眠，
 * 对方一直不开机时它会反复冒出来。
 *
 * ❗ 故意**不**写进 localStorage（已拍定）：开关名字就一个
 *   `fail-new`，永久按 key 压住的话，以后**另一台**真坏了也不会再报。
 *   重启后重新提一次，与按钮上那句「本次不再提示」对得上。
 */
interface DismissedState {
  dismissed: Record<string, boolean>;
  dismiss: (key: string) => void;
}

const useDismissed = create<DismissedState>((set) => ({
  dismissed: {},
  dismiss: (key) => set((s) => ({ dismissed: { ...s.dismissed, [key]: true } })),
}));

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
 *
 * `assets_skipped`（W1）是同一类事里**方向相反**的一条：不是「没收到」而是
 * 「没发出去」。对端只会看到一张断图且分辨不出原因，能处理的只有发送侧的人。
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
  const dismissed = useDismissed((s) => s.dismissed);
  const dismiss = useDismissed.getState().dismiss;

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
  // ❗ 不能只看 `live`（组播听得见）：WAN 对端永远不在里面，而它可能正在好好同步。
  //   理由与完整判据见 `@/lib/kbOnline`。
  const onlineCount = countKbOnline(devices, live);
  const skew = last.find((l) => l.clock_too_far_ahead_ms != null);
  /**
   * 🔴 分级依据不是「有没有失败」，是「**你能不能处理**」。
   *
   * 旧实现是 `fails > 0` 就一台一行橙色 warn。可「对方没开机」是**常态**：
   * 退避封顶 300 秒、第 20 次后才休眠，所以对方关机一天，那行橙色就挂一天、
   * 次数一路涨到几十；配几台就几行。而状态行第一句已经写了「对方都不在线」。
   *
   * 更糟的是它与「对端时钟不对」「有几处冲突副本」同一视觉权重——
   * 前者你什么都做不了，后者你必须处理。常态把真问题淹了。
   *
   * 现在分三档：
   *   已休眠            → 不出行（状态行那句就够了）
   *   从未成功过、还在试  → 合并成一行灰字
   *   曾经成功过、现在连不上 → 橙色 warn，这才是「本来好好的突然坏了」
   *
   * ❗ 不需要再加「成功得够新」的时间限制：持续失败约 1.5 小时就会休眠，
   * 所以 `!dormant && last_ok_ms > 0` 天然就意味着「没多久前还好好的」。
   */
  const failing = last.filter((l) => l.fails > 0 && !l.dormant);
  const broke = failing.filter((l) => l.last_ok_ms > 0);
  const neverOk = failing.filter((l) => l.last_ok_ms === 0);
  const skipped = newest && newest.skipped_older > 0 ? newest : null;
  // 两者分开算：原因不同（没传到 vs 传到了写不进库），文案也不一样。
  // 但都属于「没落地」，后端都会把游标夹在它们前面、下一轮重来。
  const live0 = last.filter((l) => l.fails === 0);
  const lostFiles = live0.reduce((a, l) => a + l.missing_files, 0);
  const failedImports = live0.reduce((a, l) => a + l.import_failed, 0);
  // ❗ 这一条与上面两条方向相反：它是**本机没发出去**，只有这边看得见。
  const assetsSkipped = live0.reduce((a, l) => a + l.assets_skipped, 0);
  // W2：偶尔非 0 是正常的、下一轮就消失；**持续**非 0 才是修不好。
  // 面板记不住历史，分辨不了两者，所以用 info 调、可一键压掉。
  const diverged = live0.reduce((a, l) => a + l.diverged_buckets, 0);

  const TONE = { bad: styles.rowBad, warn: styles.rowWarn, info: styles.rowInfo } as const;

  const row = (key: string, tone: "warn" | "bad" | "info", body: React.ReactNode) => {
    if (dismissed[key]) return null;
    return (
      <div key={key} className={`${styles.row} ${TONE[tone]}`}>
        <div className={styles.rowBody}>{body}</div>
        {/* 压到重启（不写进配置）：这些提示本来就该在问题解决后自己消失。
            为何不是组件内的 state（以前就是，而那是个 bug）：看 `useDismissed`。 */}
        <button
          type="button"
          className={styles.dismiss}
          onClick={() => dismiss(key)}
          title="本次不再提示"
          aria-label="本次不再提示"
        >
          ×
        </button>
      </div>
    );
  };

  return (
    <div className={styles.bar}>
      <div className={styles.status}>
        <span className={`${styles.dot}${onlineCount > 0 ? ` ${styles.dotOnline}` : ""}`} />
        <span className={styles.statusText}>
          {newest
            ? <>已与 <b>{name(newest.peer)}</b> 同步 · {ago(newest.at_ms)}</>
            : <>已配对 {devices.length} 台 · {onlineCount > 0 ? "正在等下一轮" : "对方都不在线"}</>}
        </span>
        {/* 🔴 用真实的抖动值，**不要写死 30 秒**：实际间隔是 20~40 秒，
            写死了盯着表的人会觉得程序坏了 */}
        {newest && newest.next_in_secs > 0 && (
          <span className={styles.next}>下次约 {newest.next_in_secs} 秒后</span>
        )}
      </div>

      {skew && row("skew", "bad", <>
        <b>{name(skew.peer)} 的系统时间比本机快 {mins(skew.clock_too_far_ahead_ms!)}</b>
        <div className={styles.detail}>
          <b>你在这台机器上改的笔记会一直判输</b>——它的时间戳永远更大。
          请校准两台机器的系统时间，改完自动恢复。
        </div>
      </>)}

      {backlog > 0 && row("conflict", "warn", <>
        <b>有 {backlog} 处冲突副本还没处理</b>
        <div className={styles.detail}>
          两台设备在同一段时间里各改了同一篇。<b>两个版本都留着了，没有丢。</b>{" "}
          <button type="button" className={styles.linkBtn} onClick={onSearchConflicts}>
            查看这 {backlog} 处 →
          </button>
        </div>
      </>)}

      {skipped && row("skipped", "info", <>
        最近一次有 <b>{skipped.skipped_older} 篇</b>以本机版本为准，对端那几篇更旧、已跳过。
      </>)}

      {lostFiles > 0 && row("truncated", "warn", <>
        <b>有 {lostFiles} 篇没传完</b>
        <div className={styles.detail}>
          清单里说有、文件却没到，通常是网络抖了一下。下一轮会自动重来。
        </div>
      </>)}

      {failedImports > 0 && row("import-failed", "warn", <>
        <b>有 {failedImports} 篇没能存进来</b>
        <div className={styles.detail}>
          文件收到了，但写入失败——最常见的原因是<b>单篇太大</b>（超过 10MB）。
          同步会一直重试这几篇，在它们进来之前更新的内容不会被跳过。
        </div>
      </>)}

      {diverged > 0 && row("diverged", "info", <>
        最近一次对账发现 <b>{diverged} 处</b>两边对不上，已经把那几块重新同过一遍。
        <b>没有丢东西。</b>如果这条提示一直在，说明没修好——那是个 bug。
      </>)}

      {assetsSkipped > 0 && row("assets-skipped", "warn", <>
        <b>有 {assetsSkipped} 张图没发出去</b>
        <div className={styles.detail}>
          对方那边这几张会显示成断图。要么是<b>原图已不在本机</b>（图片目录被清过），
          要么是<b>单张超过 10MB</b>。<b>只有这台看得见</b>——对方无从分辨。
        </div>
      </>)}

      {/* 曾经成功过、现在连不上——唯一值得报警的一档。
          写出「之前还好好的」，因为那才是你判断要不要去查的依据 */}
      {broke.map((f) => row(`fail-${f.peer}`, "warn", <>
        <b>连不上 {name(f.peer)}（{ago(f.last_ok_ms)}还好好的）</b>
        <div className={styles.detail}>
          {f.next_in_secs} 秒后重试。对方可能刚关机、换了网络，或关了这个开关。
          {f.error && <span className={styles.muted}>（{f.error}）</span>}
        </div>
      </>))}

      {/* 从未连上过的：合并成一行灰字。你处理不了，也不需要一台一行——
          但不能完全不报：刚配对完就连不上是真会发生的，而那时候你得知道 */}
      {neverOk.length > 0 && row("fail-new", "info", <>
        还没连上 <b>{neverOk.length} 台</b>（{neverOk.map((f) => name(f.peer)).join("、")}），还在重试。
        {neverOk[0].error && (
          <span className={styles.muted}>（{neverOk[0].error}）</span>
        )}
      </>)}
    </div>
  );
}
