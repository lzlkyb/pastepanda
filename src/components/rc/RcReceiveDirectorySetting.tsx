import { useCallback, useEffect, useRef, useState } from "react";
import { invoke } from "@tauri-apps/api/core";
import { rcFileDefaultDir, rcFileReceiveDirSet } from "@/lib/api/rcFile";
import type { useToast } from "@/components/Toast";
import styles from "./RemoteComputer.module.css";

export function RcReceiveDirectorySetting({ toast }: { toast: ReturnType<typeof useToast>["toast"] }) {
  const [directory, setDirectory] = useState("");
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [busy, setBusy] = useState(false);
  const mounted = useRef(true);
  const changing = useRef(false);
  const reading = useRef(0);

  const load = useCallback(async () => {
    const request = ++reading.current;
    setPhase("loading");
    try {
      const path = await rcFileDefaultDir();
      if (mounted.current && request === reading.current) {
        setDirectory(path);
        setPhase(path ? "ready" : "error");
      }
    } catch {
      if (mounted.current && request === reading.current) setPhase("error");
    }
  }, []);

  useEffect(() => {
    // 设置页切走会卸载，重新进入时重新读取后端目录，不保留过期缓存。
    mounted.current = true;
    void load();
    return () => {
      mounted.current = false;
    };
  }, [load]);

  const change = async () => {
    if (changing.current) return;
    changing.current = true;
    setBusy(true);
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const chosen = await open({
        directory: true,
        multiple: false,
        title: "选择文件接收目录",
        defaultPath: directory || undefined,
      });
      if (typeof chosen !== "string") return;
      const path = await rcFileReceiveDirSet(chosen);
      if (mounted.current) {
        setDirectory(path);
        setPhase("ready");
      }
      toast("文件接收目录已更新", "success");
    } catch (error) {
      toast(`无法更改接收目录：${String(error)}`, "error");
    } finally {
      changing.current = false;
      if (mounted.current) setBusy(false);
    }
  };

  const openDirectory = async () => {
    try {
      await invoke("open_file_location", { path: directory });
    } catch {
      toast("无法打开接收目录，请检查目录是否存在", "error");
    }
  };

  return (
    <div className={styles.setRow}>
      <div className={styles.setRowInfo}>
        <div className={styles.setRowTitle}>文件接收目录</div>
        <div className={styles.setRowHint}>接收的文件保存到这里；是否自动接收由设备权限决定</div>
      </div>
      <span
        className={`${styles.setRowTitle} ${styles.setRowPath}`}
        title={phase === "ready" ? directory : undefined}
        role="status"
      >
        {phase === "loading" ? "读取中…" : phase === "error" ? "接收目录读取失败" : directory}
      </span>
      {phase === "error" && (
        <button type="button" className={styles.miniBtn} disabled={busy} onClick={() => void load()}>
          重试
        </button>
      )}
      <button
        type="button"
        className={styles.miniBtn}
        disabled={busy || phase === "loading"}
        aria-busy={busy}
        onClick={() => void change()}
      >
        {busy ? "更改中…" : "更改"}
      </button>
      <button
        type="button"
        className={styles.miniBtn}
        disabled={busy || phase !== "ready"}
        title="在资源管理器中打开该目录"
        onClick={() => void openDirectory()}
      >
        打开
      </button>
    </div>
  );
}
