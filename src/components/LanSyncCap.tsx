/**
 * LanSyncCap — 剪贴板同步状态胶囊 + 浮层（方案 A：挂记录模式标签筛选行最右）。
 *
 * 24px 紧凑胶囊，与 tagFilterAdd 同高；点开浮层、窗口隐藏停轮询。
 * 数据：running（监听线程）+ paired（在线数/记住数），5s 轮询。
 * 开关关闭时不渲染（TopBar 也不会为它空占标签行）。
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { useAppStore } from "@/stores/appStore";
import { useWindowVisible } from "@/hooks/useWindowVisible";
import { openSettingsTab } from "@/lib/openSettings";
import { logger } from "@/lib/logger";
import styles from "./LanSyncCap.module.css";

interface PairedLite {
  online: boolean;
  device_name: string;
  last_sync: string;
}

export function LanSyncCap() {
  const enabled = useAppStore((s) => s.config.lan_sync_enabled);
  const [running, setRunning] = useState(true);
  const [devices, setDevices] = useState<PairedLite[]>([]);
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement>(null);

  const refresh = useCallback(async () => {
    try {
      const { invoke } = await import("@tauri-apps/api/core");
      const [list, alive] = await Promise.all([
        invoke<PairedLite[]>("get_lan_paired"),
        invoke<boolean>("get_lan_running"),
      ]);
      setDevices(list);
      setRunning(alive);
    } catch (e) {
      logger.warn("剪贴板同步状态刷新失败", e);
    }
  }, []);

  const winVisible = useWindowVisible();
  useEffect(() => {
    if (!enabled || !winVisible) return;
    void refresh();
    const t = setInterval(() => void refresh(), 5000);
    return () => clearInterval(t);
  }, [enabled, winVisible, refresh]);

  useEffect(() => {
    if (!open) return;
    const onDown = (e: MouseEvent) => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", onDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [open]);

  if (!enabled) return null;

  const online = devices.filter((d) => d.online);
  const last = online.find((d) => d.last_sync);
  // 文案恒为「同步」——状态靠圆点/角标/浮层说，行内不塞长句
  const dotClass = !running
    ? styles.dotBad
    : online.length > 0
      ? styles.dotOk
      : styles.dot;

  return (
    <div className={styles.wrap} ref={wrapRef}>
      <button
        type="button"
        className={styles.cap}
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        aria-haspopup="dialog"
        title={
          !running
            ? "剪贴板同步 · 监听未启动"
            : online.length > 0
              ? `剪贴板同步 · 在线 ${online.length} 台`
              : "剪贴板同步 · 监听中，等待其他设备"
        }
      >
        <span className={`${styles.dot} ${dotClass}`} />
        <span>同步</span>
        {running && online.length > 0 && (
          <span className={styles.badge} aria-label={`${online.length} 台在线`}>
            {online.length}
          </span>
        )}
      </button>

      {open && (
        <div className={styles.pop} role="dialog" aria-label="剪贴板同步状态">
          <div className={styles.head}>
            <span className={styles.headTitle}>剪贴板同步</span>
            <button
              type="button"
              className={styles.x}
              onClick={() => setOpen(false)}
              aria-label="关闭"
            >
              ×
            </button>
          </div>
          <div className={styles.body}>
            <div className={styles.row}>
              <span>状态</span>
              <b className={!running ? styles.bad : undefined}>
                {!running ? "监听未启动" : "监听中"}
              </b>
            </div>
            <div className={styles.row}>
              <span>在线</span>
              <b>{online.length > 0 ? `${online.length} 台` : "0 台"}</b>
            </div>
            <div className={styles.row}>
              <span>记住</span>
              <b>{devices.length} 台</b>
            </div>
            {last?.last_sync ? (
              <div className={styles.row}>
                <span>最近同步</span>
                <b>
                  {last.last_sync} · {last.device_name}
                </b>
              </div>
            ) : (
              <div className={styles.row}>
                <span>最近同步</span>
                <b className={styles.muted}>本次运行还没有</b>
              </div>
            )}
            {!running && (
              <p className={styles.alert}>
                端口可能被占用，或网卡无法加入组播。到设置里关掉再打开可重试。
              </p>
            )}
            {running && online.length === 0 && (
              <p className={styles.hint}>
                同一网络内另一台电脑也打开「剪贴板同步」后，会出现在附近设备里。
              </p>
            )}
          </div>
          <div className={styles.foot}>
            <button
              type="button"
              className={styles.link}
              onClick={() => {
                setOpen(false);
                // section=lan：滚到通用页里的「剪贴板同步」分区，而不是停在数据统计
                openSettingsTab("general", "lan");
              }}
            >
              打开设置
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
