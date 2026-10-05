import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen, type UnlistenFn } from "@tauri-apps/api/event";
import { getVersion } from "@tauri-apps/api/app";
import { rcErrorText } from "../devices/rcErrorText";

// 与桌面 UpdateContext 同一事件契约（update_android.rs 收口点）；
// 这里只做移动端自己的状态机，桌面端零改动。
export type MobileUpdateStatus =
  | "idle"
  | "checking"
  | "uptodate"
  | "available"
  | "downloading"
  | "ready"
  | "needPermission"
  | "error";
export type MobileUpdateInfo = { version: string; body: string | null };
export type MobileUpdateProgress = { downloaded: number; total: number | null };

const LAST_CHECK_KEY = "pastepanda_mobile_last_update_check";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

export function fmtBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0 KB";
  if (n >= 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  if (n >= 1024) return `${Math.round(n / 1024)} KB`;
  return `${n} B`;
}

export function progressText(p: MobileUpdateProgress | null): string {
  if (!p) return "正在准备下载…";
  const pct = p.total && p.total > 0 ? ` ${Math.min(Math.round((p.downloaded / p.total) * 100), 100)}%` : "";
  return `已下载 ${fmtBytes(p.downloaded)}${p.total ? ` / ${fmtBytes(p.total)}` : ""}${pct}`;
}

export type MobileUpdate = {
  status: MobileUpdateStatus;
  info: MobileUpdateInfo | null;
  installed: string;
  progress: MobileUpdateProgress | null;
  error: string | null;
  installAllowed: boolean;
  busy: boolean;
  checkNow: () => Promise<void>;
  startUpdate: () => Promise<void>;
  openInstallSettings: () => Promise<void>;
  /** 只清错误文案，不动 status（dismiss 会把 needPermission 等流程态一起重置）。 */
  clearError: () => void;
  dismiss: () => void;
};

const MobileUpdateCtx = createContext<MobileUpdate | null>(null);

export function useMobileUpdate(): MobileUpdate {
  const ctx = useContext(MobileUpdateCtx);
  if (!ctx) throw new Error("useMobileUpdate 必须在 MobileUpdateProvider 内使用");
  return ctx;
}

export function MobileUpdateProvider({ children }: { children: ReactNode }) {
  const [status, setStatus] = useState<MobileUpdateStatus>("idle");
  const [info, setInfo] = useState<MobileUpdateInfo | null>(null);
  const [installed, setInstalled] = useState("");
  const [progress, setProgress] = useState<MobileUpdateProgress | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [installAllowed, setInstallAllowed] = useState(true);
  const [busy, setBusy] = useState(false);
  const statusRef = useRef(status);
  statusRef.current = status;

  const refreshInstallStatus = useCallback(async () => {
    try {
      const r = await invoke<{ allowed: boolean }>("apk_install_status");
      setInstallAllowed(r.allowed);
    } catch {
      // 非 Tauri 环境（浏览器调试）没有该命令，按「有权限」处理，不阻塞界面。
    }
  }, []);

  useEffect(() => {
    void getVersion()
      .then(setInstalled)
      .catch(() => {});
    void refreshInstallStatus();
    const unlisteners: UnlistenFn[] = [];
    let alive = true;
    const attach = async <T,>(event: string, handler: (payload: T) => void) => {
      const un = await listen<T>(event, (e) => {
        if (alive) handler(e.payload);
      });
      if (!alive) un();
      else unlisteners.push(un);
    };
    void (async () => {
      await attach("update:checking", () => {
        setError(null);
        setStatus("checking");
      });
      await attach<MobileUpdateInfo>("update:available", (p) => {
        setInfo(p);
        setStatus("available");
      });
      await attach("update:downloading", () => {
        setProgress(null);
        setStatus("downloading");
      });
      await attach<MobileUpdateProgress>("update:progress", (p) => setProgress(p));
      await attach("update:ready", () => setStatus("ready"));
      await attach("update:uptodate", () => setStatus("uptodate"));
      await attach<{ source: string; avg_bps: number }>("update:source_slow", (p) => {
        console.warn(`[Update] 源过慢已切换: ${p.source} ≈ ${Math.round(p.avg_bps / 1024)}KB/s`);
      });
      await attach<{ message: string }>("update:error", (p) => {
        setError(rcErrorText(p.message));
        setStatus("error");
        setBusy(false);
      });
      await attach("update:needPermission", () => {
        setInstallAllowed(false);
        setStatus("needPermission");
      });
      // 24 小时静默自检（与桌面节奏一致）；无新版本时不打扰用户。
      const last = Number(localStorage.getItem(LAST_CHECK_KEY) ?? "0");
      if (Number.isFinite(last) && Date.now() - last >= CHECK_INTERVAL_MS) {
        void (async () => {
          try {
            const r = await invoke<MobileUpdateInfo | null>("check_update");
            localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
            if (r && statusRef.current === "idle") {
              setInfo(r);
              setStatus("available");
            }
          } catch {
            // 后台自检失败保持静默，用户手动检查时会看到同样的错误。
          }
        })();
      }
    })();
    return () => {
      alive = false;
      unlisteners.forEach((fn) => fn());
    };
  }, [refreshInstallStatus]);

  // 从系统「安装未知应用」设置页返回后刷新权限态，用户不用重进 App。
  useEffect(() => {
    const onVisible = () => {
      if (document.visibilityState === "visible") void refreshInstallStatus();
    };
    document.addEventListener("visibilitychange", onVisible);
    return () => document.removeEventListener("visibilitychange", onVisible);
  }, [refreshInstallStatus]);

  const checkNow = useCallback(async () => {
    if (busy) return;
    setBusy(true);
    setStatus("checking");
    setError(null);
    try {
      const r = await invoke<MobileUpdateInfo | null>("check_update");
      localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
      if (r) {
        setInfo(r);
        setStatus("available");
      } else {
        setStatus("uptodate");
      }
    } catch (e) {
      setError(rcErrorText(e));
      setStatus("error");
    } finally {
      setBusy(false);
    }
  }, [busy]);

  // 完整「检查→下载→拉起安装器」流程由后端 spawn 推事件；缓存命中时秒回。
  const startUpdate = useCallback(async () => {
    setError(null);
    setProgress(null);
    try {
      await invoke("start_update");
    } catch (e) {
      setError(rcErrorText(e));
      setStatus("error");
    }
  }, []);

  const openInstallSettings = useCallback(async () => {
    try {
      await invoke("apk_open_install_settings");
    } catch {
      // 原始异常对用户没有信息量，直接给可执行的替代路径（规则 15.3：不许点了没反应）。
      setError("未能打开授权页，请到系统设置 → 应用管理里手动允许「安装未知应用」，然后返回本页。");
    }
  }, []);

  const clearError = useCallback(() => setError(null), []);
  const dismiss = useCallback(() => {
    setStatus("idle");
    setError(null);
  }, []);

  return (
    <MobileUpdateCtx.Provider
      value={{
        status,
        info,
        installed,
        progress,
        error,
        installAllowed,
        busy,
        checkNow,
        startUpdate,
        openInstallSettings,
        clearError,
        dismiss,
      }}
    >
      {children}
    </MobileUpdateCtx.Provider>
  );
}
