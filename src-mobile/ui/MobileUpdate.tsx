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
  | "skipped"
  | "error";
export type MobileUpdateInfo = { version: string; body: string | null };
export type MobileUpdateProgress = { downloaded: number; total: number | null };

const LAST_CHECK_KEY = "pastepanda_mobile_last_update_check";
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;
// 跳过某版本后不再自动提示（与桌面 pastepanda_skip_ 同前缀、同语义）。
const SKIP_VERSION_PREFIX = "pastepanda_skip_";
function isVersionSkipped(version: string): boolean {
  return localStorage.getItem(`${SKIP_VERSION_PREFIX}${version}`) === "1";
}

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
  /** 跳过当前 available 的版本：记 flag、置 skipped 态、横幅消失，之后自动检查不再打扰。 */
  skipThisVersion: () => void;
  /** 取消跳过当前版本：清 flag、回到 available（唯一的取消路径，别把人锁死）。 */
  unskipThisVersion: () => void;
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
  const checkingRef = useRef(false);

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
        setStatus(isVersionSkipped(p.version) ? "skipped" : "available");
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
    if (checkingRef.current) return;
    checkingRef.current = true;
    setBusy(true);
    setStatus("checking");
    setError(null);
    try {
      const r = await invoke<MobileUpdateInfo | null>("check_update");
      localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
      if (r) {
        setInfo(r);
        setStatus(isVersionSkipped(r.version) ? "skipped" : "available");
      } else {
        setStatus("uptodate");
      }
    } catch (e) {
      setError(rcErrorText(e));
      setStatus("error");
    } finally {
      checkingRef.current = false;
      setBusy(false);
    }
  }, []);

  // 静默检查：仍真发一次 check_update，但只在有新版本且当前空闲时浮现横幅；
  // 不进 checking 态、不落 uptodate/error，与桌面 silentCheck 同口径。
  const silentCheck = useCallback(async () => {
    if (checkingRef.current) return;
    checkingRef.current = true;
    try {
      const r = await invoke<MobileUpdateInfo | null>("check_update");
      localStorage.setItem(LAST_CHECK_KEY, String(Date.now()));
      if (r && statusRef.current === "idle" && !isVersionSkipped(r.version)) {
        setInfo(r);
        setStatus("available");
      }
    } catch {
      // 后台自检失败保持静默，用户手动检查时会看到同样的错误。
    } finally {
      checkingRef.current = false;
    }
  }, []);

  // 启动自检 + 24h 复查，节奏对齐桌面 UpdateContext：
  // 距上次 <24h → 静默检查（照样查、有新版才打扰）；≥24h 或首次 → 可见检查；
  // 运行中每 24h setInterval 复查一次（App 常驻才触发，后台被系统杀后靠冷启动补）。
  useEffect(() => {
    const last = Number(localStorage.getItem(LAST_CHECK_KEY) ?? "0");
    const within = Number.isFinite(last) && last > 0 && Date.now() - last < CHECK_INTERVAL_MS;
    void (within ? silentCheck() : checkNow());
    const timer = setInterval(() => void checkNow(), CHECK_INTERVAL_MS);
    return () => clearInterval(timer);
    // 启动自检 + 定时器本就只该装一次：checkNow/silentCheck 虽是稳定 useCallback，
    // 但一旦进依赖数组，将来任何重建都会重装 setInterval 把 24h 计时归零，
    // 所以保持 [] 并关掉 exhaustive-deps。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // 跳过 = 记版本 flag + 转 skipped 态（横幅随 status 消失）；不依赖 info 之外的状态。
  const skipThisVersion = useCallback(() => {
    if (!info) return;
    localStorage.setItem(`${SKIP_VERSION_PREFIX}${info.version}`, "1");
    setStatus("skipped");
  }, [info]);

  const unskipThisVersion = useCallback(() => {
    if (!info) return;
    localStorage.removeItem(`${SKIP_VERSION_PREFIX}${info.version}`);
    setStatus("available");
  }, [info]);

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
        skipThisVersion,
        unskipThisVersion,
        clearError,
        dismiss,
      }}
    >
      {children}
    </MobileUpdateCtx.Provider>
  );
}
