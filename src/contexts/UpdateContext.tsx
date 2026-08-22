import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from "react";
import { relaunch } from "@tauri-apps/plugin-process";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { logger } from "@/lib/logger";
import { toastActionFailed } from "@/lib/utils";
import { useToast } from "@/components/Toast";

// ─── 类型定义 ───────────────────────────────────────────

export type UpdateStatus = "idle" | "checking" | "available" | "downloading" | "ready" | "error" | "installed" | "uptodate" | "skipped";

/** 本地更新信息（替代 @tauri-apps/plugin-updater 的 Update 类型，数据统一从 Rust 多源路径获取） */
export interface UpdateInfo {
  version: string;
  body: string | null;
}

export interface UpdateState {
  status: UpdateStatus;
  /** 更新信息（available / downloading / ready 时有值） */
  update: UpdateInfo | null;
  /** 下载进度 0-100 */
  progress: number;
  /** 进度不确定（total 未知，如某些源不返回 Content-Length） */
  progressIndeterminate: boolean;
  /** 已下载字节数（不确定态下显示 "已下载 X MB"） */
  downloadedBytes: number;
  /** 下载速率（字节/秒，前端根据 downloaded 差值计算） */
  bytesPerSec: number;
  /** 错误信息 */
  error: string | null;
  /** 手动触发检查更新 */
  checkForUpdate: () => Promise<void>;
  /** 下载并安装更新 */
  downloadAndInstall: () => Promise<void>;
  /** 立即重启应用 */
  restart: () => Promise<void>;
  /** 标记已安装（重启前显示提示） */
  markInstalled: () => void;
  /** 跳过当前版本（不再提示） */
  skipThisVersion: () => void;
}

// ─── Context ────────────────────────────────────────────

const UpdateContext = createContext<UpdateState | null>(null);

export function useUpdate() {
  const ctx = useContext(UpdateContext);
  if (!ctx) throw new Error("useUpdate 必须在 UpdateProvider 内使用");
  return ctx;
}

// ─── 工具函数 ──────────────────────────────────────────

export interface FriendlyError {
  /** 用户友好文案 */
  friendly: string;
  /** 原始错误信息（技术细节） */
  raw: string;
}

/** 将原始错误信息拆分为友好提示 + 原始错误，横幅显示友好文案，原始错误作为技术细节展示 */
export function friendlyError(raw: string): FriendlyError {
  const lower = raw.toLowerCase();
  if (lower.includes("networkerror") || lower.includes("failed to fetch") || lower.includes("fetch")) {
    return { friendly: "网络连接失败，请检查网络后重试", raw };
  }
  if (lower.includes("enotfound") || lower.includes("getaddrinfo") || lower.includes("dns")) {
    return { friendly: "无法解析更新服务器地址，请检查网络连接", raw };
  }
  if (lower.includes("timeout") || lower.includes("timed out")) {
    return { friendly: "连接超时，请稍后重试", raw };
  }
  if (lower.includes("403") || lower.includes("rate limit")) {
    return { friendly: "GitHub API 访问受限，请稍后重试", raw };
  }
  return { friendly: "更新失败，请重试", raw };
}

// ─── 常量 ──────────────────────────────────────────────

/** 自动检查间隔：24 小时 */
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
const LAST_CHECK_KEY = "pastepanda_last_update_check";
const SKIP_VERSION_PREFIX = "pastepanda_skip_";

/** 检查某版本是否被用户标记为"跳过" */
function isVersionSkipped(version: string): boolean {
  return localStorage.getItem(`${SKIP_VERSION_PREFIX}${version}`) === "1";
}

/** 标记某版本为"跳过" */
function setVersionSkipped(version: string): void {
  localStorage.setItem(`${SKIP_VERSION_PREFIX}${version}`, "1");
}

// ─── Provider ───────────────────────────────────────────

export function UpdateProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<UpdateStatus>("idle");
  const [update, setUpdate] = useState<UpdateInfo | null>(null);
  const [progress, setProgress] = useState(0);
  const [progressIndeterminate, setProgressIndeterminate] = useState(false);
  const [downloadedBytes, setDownloadedBytes] = useState(0);
  const [bytesPerSec, setBytesPerSec] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();
  const checkingRef = useRef(false);
  const downloadingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const uptodateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const downloadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** 用于前端计算下载速率：记录上次 downloaded 值和时间戳 */
  const speedRef = useRef<{ downloaded: number; time: number }>({ downloaded: 0, time: 0 });
  /** rAF 节流：事件写入 ref，rAF 批量刷 state（避免高频 setState 抖动） */
  const progressRef = useRef<{ pct: number; indeterminate: boolean; downloaded: number; bps: number }>({ pct: 0, indeterminate: false, downloaded: 0, bps: 0 });
  const rafRef = useRef<number | null>(null);

  /** 清除"已是最新"4 秒回退计时器，避免过期计时器在状态已变化后再次覆盖为 idle */
  const clearUptodateTimer = useCallback(() => {
    if (uptodateTimerRef.current) {
      clearTimeout(uptodateTimerRef.current);
      uptodateTimerRef.current = null;
    }
  }, []);

  // ─── 启动时自动检查 ──────────────────────────────────

  useEffect(() => {
    const doStartupCheck = async () => {
      const lastCheck = localStorage.getItem(LAST_CHECK_KEY);
      const now = Date.now();

      if (lastCheck) {
        const elapsed = now - Number(lastCheck);
        if (elapsed < CHECK_INTERVAL_MS) {
          await silentCheck();
          return;
        }
      }

      await checkForUpdate();
    };

    doStartupCheck();

    timerRef.current = setInterval(() => {
      checkForUpdate();
    }, CHECK_INTERVAL_MS);

    return () => {
      if (timerRef.current) clearInterval(timerRef.current);
      clearUptodateTimer();
      if (downloadTimeoutRef.current) clearTimeout(downloadTimeoutRef.current);
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    };
    // 不能补依赖：checkForUpdate / silentCheck 都定义在本 effect 之后，
    // 写进依赖数组会在 const 初始化前读取 → TDZ ReferenceError。
    // 而且这是启动检查 + 轮询定时器，本来就只能装一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // ─── 静默检查（不改变 UI 状态，仅内部记录）─────────

  const silentCheck = useCallback(async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    try {
      const result = await invoke<{ version: string; body: string | null } | null>("check_update");
      if (result) {
        // 检查版本是否被跳过
        if (isVersionSkipped(result.version)) {
          logger.info(`[Update] 版本 v${result.version} 已被用户标记为跳过`);
          return;
        }
        clearUptodateTimer();
        setStatus("available");
        setUpdate({ version: result.version, body: result.body });
      }
    } catch {
      // 静默检查失败不处理
    } finally {
      checkingRef.current = false;
      localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
    }
  }, [clearUptodateTimer]);

  // ─── 检查更新（统一走 Rust 多源路径）─────────────────

  const checkForUpdate = useCallback(async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;

    clearUptodateTimer();
    setStatus("checking");
    setError(null);

    try {
      // Rust 侧已内置多源 failover + 指数退避重试，前端无需再重试
      const result = await invoke<{ version: string; body: string | null } | null>("check_update");
      if (result) {
        // 检查版本是否被跳过
        if (isVersionSkipped(result.version)) {
          clearUptodateTimer();
          setStatus("skipped");
          setUpdate({ version: result.version, body: result.body });
          toast(`v${result.version} 已被跳过（可在设置中取消）`, "info");
          return;
        }
        clearUptodateTimer();
        setStatus("available");
        setUpdate({ version: result.version, body: result.body });
        toast(`发现新版本 v${result.version}`, "info");
      } else {
        setStatus("uptodate");
        setUpdate(null);
        toast("已是最新版本", "success");
        // 4 秒后自动回到 idle
        clearUptodateTimer();
        uptodateTimerRef.current = setTimeout(() => {
          setStatus("idle");
        }, 4000);
      }
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      logger.error("[Update] 检查更新失败:", msg);
      setError(msg);
      setStatus("error");
      const fe = friendlyError(msg);
      toast(`${fe.friendly}（${fe.raw}）`, "error", undefined, undefined, undefined, fe.raw);
    } finally {
      checkingRef.current = false;
      localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
    }
  }, [clearUptodateTimer, toast]);

  // ─── 下载并安装（后台线程，不阻塞 UI）────────────

  const downloadAndInstall = useCallback(async () => {
    if (!update) return;
    // 防止快速重复点击导致并发触发多个 start_update
    if (downloadingRef.current) return;
    downloadingRef.current = true;

    // 兜底：若后端迟迟未推送 update:downloading 事件，避免 downloadingRef 被永久卡死
    if (downloadTimeoutRef.current) clearTimeout(downloadTimeoutRef.current);
    downloadTimeoutRef.current = setTimeout(() => {
      downloadingRef.current = false;
      downloadTimeoutRef.current = null;
    }, 15000);

    // 启动后台下载（Rust 侧 spawn 线程，通过 event 推送状态）
    invoke("start_update").catch((e) => {
      logger.error("[Update] start_update invoke 失败:", e);
      setError(String(e));
      setStatus("error");
      downloadingRef.current = false;
      if (downloadTimeoutRef.current) {
        clearTimeout(downloadTimeoutRef.current);
        downloadTimeoutRef.current = null;
      }
    });
  }, [update]);

  // ─── 监听后台更新事件 ──────────────────────────────

  useEffect(() => {
    const unlisteners: UnlistenFn[] = [];

    const setupListeners = async () => {
      unlisteners.push(
        await listen("update:checking", () => {
          clearUptodateTimer();
          setStatus("checking");
          setError(null);
        }),
      );

      unlisteners.push(
        await listen<{ version: string; body: string | null }>("update:available", (e) => {
          clearUptodateTimer();
          // 检查版本是否被跳过
          if (isVersionSkipped(e.payload.version)) {
            setStatus("skipped");
          } else {
            setStatus("available");
          }
          setUpdate({ version: e.payload.version, body: e.payload.body });
        }),
      );

      unlisteners.push(
        await listen("update:downloading", () => {
          clearUptodateTimer();
          downloadingRef.current = false;
          if (downloadTimeoutRef.current) {
            clearTimeout(downloadTimeoutRef.current);
            downloadTimeoutRef.current = null;
          }
          // 多源 failover 时不重置已有进度（避免 30% → 0% 跳变）
          setStatus((prev) => {
            if (prev !== "downloading") {
              setProgress(0);
              setDownloadedBytes(0);
              progressRef.current = { pct: 0, indeterminate: false, downloaded: 0, bps: 0 };
            }
            return "downloading";
          });
          setProgressIndeterminate(false);
          setBytesPerSec(0);
          speedRef.current = { downloaded: 0, time: Date.now() };
        }),
      );

      unlisteners.push(
        await listen<{ downloaded: number; total: number | null }>("update:progress", (e) => {
          const { downloaded, total } = e.payload;
          const now = Date.now();

          // 速率计算（节流 0.3s）
          const prev = speedRef.current;
          const dt = (now - prev.time) / 1000;
          let bps = progressRef.current.bps;
          if (dt > 0.3) {
            bps = Math.round((downloaded - prev.downloaded) / dt);
            speedRef.current = { downloaded, time: now };
          }

          // 写入 ref（不直接 setState）
          progressRef.current = {
            pct: total ? Math.round((downloaded / total) * 100) : progressRef.current.pct,
            indeterminate: !total,
            downloaded,
            bps,
          };

          // rAF 批量刷新（~16ms 一帧，避免高频 setState 导致进度条抖动）
          if (rafRef.current === null) {
            rafRef.current = requestAnimationFrame(() => {
              rafRef.current = null;
              const p = progressRef.current;
              setProgress(p.pct);
              setProgressIndeterminate(p.indeterminate);
              setDownloadedBytes(p.downloaded);
              setBytesPerSec(p.bps);
            });
          }
        }),
      );

      unlisteners.push(
        await listen("update:ready", () => {
          clearUptodateTimer();
          setProgress(100);
          setStatus("ready");
        }),
      );

      unlisteners.push(
        await listen<{ message: string }>("update:error", (e) => {
          const msg = e.payload.message;
          logger.error("[Update] 更新失败:", msg);
          clearUptodateTimer();
          downloadingRef.current = false;
          if (downloadTimeoutRef.current) {
            clearTimeout(downloadTimeoutRef.current);
            downloadTimeoutRef.current = null;
          }
          setError(msg);
          setStatus("error");
          const fe2 = friendlyError(msg);
          toast(`${fe2.friendly}（${fe2.raw}）`, "error");
        }),
      );

      unlisteners.push(
        await listen("update:uptodate", () => {
          clearUptodateTimer();
          setStatus("idle");
          setUpdate(null);
        }),
      );
    };

    setupListeners();

    return () => {
      unlisteners.forEach((fn) => fn());
    };
    // clearUptodateTimer / toast 都是 useCallback 恒引用，列进去不会重装监听
  }, [clearUptodateTimer, toast]);

  // ─── 重启应用 ────────────────────────────────────────

  const restart = useCallback(async () => {
    try {
      await relaunch();
    } catch (e) {
      logger.error("[Update] 重启失败:", e);
      toastActionFailed("重启应用", e);
    }
  }, []);

  // ─── 标记已安装 ──────────────────────────────────────

  const markInstalled = useCallback(() => {
    clearUptodateTimer();
    setStatus("installed");
  }, [clearUptodateTimer]);

  // ─── 跳过当前版本 ───────────────────────────────────

  const skipThisVersion = useCallback(() => {
    if (update) {
      setVersionSkipped(update.version);
      logger.info(`[Update] 用户跳过了版本 v${update.version}`);
      setStatus("idle");
      toast(`已跳过 v${update.version}`, "info");
    }
  }, [update, toast]);

  return (
    <UpdateContext.Provider
      value={{
        status,
        update,
        progress,
        progressIndeterminate,
        downloadedBytes,
        bytesPerSec,
        error,
        checkForUpdate,
        downloadAndInstall,
        restart,
        markInstalled,
        skipThisVersion,
      }}
    >
      {children}
    </UpdateContext.Provider>
  );
}
