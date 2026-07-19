import { createContext, useContext, useState, useCallback, useEffect, useRef, type ReactNode } from "react";
import { check, type Update } from "@tauri-apps/plugin-updater";
import { relaunch } from "@tauri-apps/plugin-process";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { logger } from "@/lib/logger";
import { useToast } from "@/components/Toast";

// ─── 类型定义 ───────────────────────────────────────────

export type UpdateStatus = "idle" | "checking" | "available" | "downloading" | "ready" | "error" | "installed" | "uptodate";

export interface UpdateState {
  status: UpdateStatus;
  /** 更新信息（available / downloading / ready 时有值） */
  update: Update | null;
  /** 下载进度 0-100 */
  progress: number;
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

// ─── Provider ───────────────────────────────────────────

export function UpdateProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<UpdateStatus>("idle");
  const [update, setUpdate] = useState<Update | null>(null);
  const [progress, setProgress] = useState(0);
  const [error, setError] = useState<string | null>(null);
  const { toast } = useToast();
  const checkingRef = useRef(false);
  const downloadingRef = useRef(false);
  const timerRef = useRef<ReturnType<typeof setInterval> | null>(null);
  const uptodateTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const downloadTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  /** 清除“已是最新”4 秒回退计时器，避免过期计时器在状态已变化后再次覆盖为 idle */
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
    };
  }, []);

  // ─── 静默检查（不改变 UI 状态，仅内部记录）─────────

  const silentCheck = useCallback(async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    try {
      const update = await check();
      if (update) {
        clearUptodateTimer();
        setStatus("available");
        setUpdate(update);
      }
    } catch {
      // 静默检查失败不处理
    } finally {
      checkingRef.current = false;
      localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
    }
  }, []);

  // ─── 指数退避重试辅助函数 ─────────────────────────

  /** 带指数退避的重试执行，最多 retries 次，间隔 1s/2s/4s/... */
  async function retryWithBackoff<T>(fn: () => Promise<T>, retries: number, label: string): Promise<T> {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        return await fn();
      } catch (e) {
        if (attempt >= retries) throw e;
        const delay = Math.pow(2, attempt) * 1000; // 1s, 2s, 4s, ...
        logger.warn(`[Update] ${label} 失败（第 ${attempt + 1}/${retries + 1} 次），${delay / 1000}s 后重试:`, e);
        await new Promise((r) => setTimeout(r, delay));
      }
    }
    throw new Error("unreachable");
  }

  // ─── 检查更新 ─────────────────────────────────────────

  const checkForUpdate = useCallback(async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;

    clearUptodateTimer();
    setStatus("checking");
    setError(null);

    try {
      // 带重试检查更新（最多 3 次，指数退避 1s/2s/4s）
      const update = await retryWithBackoff(() => check(), 3, "检查更新");
      if (update) {
        clearUptodateTimer();
        setStatus("available");
        setUpdate(update);
        toast(`发现新版本 v${update.version}`, "info");
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
      toast(`${fe.friendly}（${fe.raw}）`, "error");
    } finally {
      checkingRef.current = false;
      localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
    }
  }, []);

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
          setStatus("available");
          setUpdate({
            version: e.payload.version,
            body: e.payload.body,
          } as Update);
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
          setStatus("downloading");
          setProgress(0);
        }),
      );

      unlisteners.push(
        await listen<{ downloaded: number; total: number | null }>("update:progress", (e) => {
          const { downloaded, total } = e.payload;
          if (total) {
            const pct = Math.round((downloaded / total) * 100);
            setProgress(pct);
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
  }, []);

  // ─── 重启应用 ────────────────────────────────────────

  const restart = useCallback(async () => {
    try {
      await relaunch();
    } catch (e) {
      logger.error("[Update] 重启失败:", e);
    }
  }, []);

  // ─── 标记已安装 ──────────────────────────────────────

  const markInstalled = useCallback(() => {
    clearUptodateTimer();
    setStatus("installed");
  }, []);

  return (
    <UpdateContext.Provider
      value={{
        status,
        update,
        progress,
        error,
        checkForUpdate,
        downloadAndInstall,
        restart,
        markInstalled,
      }}
    >
      {children}
    </UpdateContext.Provider>
  );
}
