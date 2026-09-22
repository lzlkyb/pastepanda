/**
 * RcFileBar — 会话底栏里的文件操作组（G6）。不自带外框，由 `RcSessionBar` 承载。
 *
 * 与 `RcClipboardBar` 同款定位：底栏是**一条**工具栏（方案 B），所以这里只返回
 * 内容，排版交给底栏。拆出来的直接原因也是同一个——底栏文件涨到 340 行，
 * 超了 `.tsx ≤ 300`；而「传文件 / 取文件 + 进度」本来就是一个内聚的操作组。
 *
 * 三条纪律：
 *  1. **调用点必须把它放在 `canControl` 门内**。写对端磁盘与「推送剪贴板」同级，
 *     「只看」会话不该能往对方机器写文件。
 *  2. 两个按钮都先弹系统选择框再发请求——**取消选择 = 什么都不发生**，
 *     不替用户选一个他没挑过的路径（接收目录尤其不能默认落盘）。
 *  3. 失败必须出字。文件通道独立于会话（独立 ALPN），失败不会表现为画面异常，
 *     不说就完全无声。
 */
import { useCallback, useState } from "react";
import { FolderDown, FolderUp } from "lucide-react";
import { rcFileDefaultDir } from "@/lib/api/rcFile";
import { useRcFile } from "@/hooks/useRcFile";
import { useOkAutoClear } from "@/hooks/useOkAutoClear";
import styles from "./RemoteComputer.module.css";

type Fb = { kind: "ok" | "bad" | "info"; text: string } | null;

export function RcFileBar({ peer }: { peer: string }) {
  const file = useRcFile(peer || null);
  const [fb, setFb] = useState<Fb>(null);
  // P3-5：成功/信息 6s 自清，错误保留
  const clearFb = useCallback(() => setFb(null), []);
  useOkAutoClear(fb?.kind ?? null, clearFb);

  // 拿不到对端 node_id 时不摆——`useRcFile(null)` 是「不过滤」，那会把**别的设备**
  // 的任务念进这场会话的底栏里，比不显示更糟。
  if (!peer) return null;

  const send = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      const sel = await open({ multiple: true, directory: false, title: "选择要发送的文件" });
      const paths = (Array.isArray(sel) ? sel : sel ? [sel] : []).filter(
        (s): s is string => typeof s === "string",
      );
      if (paths.length === 0) return;
      const ok = await file.send(paths);
      setFb(
        ok
          ? { kind: "info", text: `已加入传输 · ${paths.length} 个文件（对方需确认）` }
          : { kind: "bad", text: "发起失败：对方可能离线或尚未配对" },
      );
    } catch (e) {
      setFb({ kind: "bad", text: `传文件失败：${e}` });
    }
  };

  const pull = async () => {
    try {
      const { open } = await import("@tauri-apps/plugin-dialog");
      // ❗ 目录必须**先**选：对方一接受就开始灌字节，没有「先请求再选目录」的顺序
      let defaultPath: string | undefined;
      try {
        defaultPath = await rcFileDefaultDir();
      } catch {
        /* 拿不到就让用户自己找 */
      }
      const dir = await open({
        directory: true,
        multiple: false,
        title: "选择接收目录",
        defaultPath,
      });
      if (typeof dir !== "string") return;
      const ok = await file.pull(dir);
      setFb(
        ok
          ? { kind: "info", text: "已发出请求 · 等对方选文件" }
          : { kind: "bad", text: "发起失败：对方可能离线或尚未配对" },
      );
    } catch (e) {
      setFb({ kind: "bad", text: `发起失败：${e}` });
    }
  };

  const fbCls = fb?.kind === "ok" ? styles.fbOk : fb?.kind === "bad" ? styles.fbBad : styles.fbInfo;

  return (
    <>
      <button
        type="button"
        className={styles.miniBtn}
        disabled={file.busy}
        title="把本机文件发给对方；对方会看到确认条，不点接受不会落盘"
        onClick={() => void send()}
      >
        <FolderUp size={13} aria-hidden="true" /> 传文件
      </button>
      <button
        type="button"
        className={styles.miniBtn}
        disabled={file.busy}
        title="向对方要文件：先选好本机保存目录，对方选完文件后开始传"
        onClick={() => void pull()}
      >
        <FolderDown size={13} aria-hidden="true" /> 取文件
      </button>
      {/* 进度：`传文件中 3/5 · 42% · 6.2 MB/s · 剩 12s`。没有传输时整条不出现
          ——「空闲」不值得占位。 */}
      {file.summary && <span className={`${styles.fb} ${styles.fbInfo}`}>{file.summary}</span>}
      {fb && <span className={`${styles.fb} ${fbCls}`}>{fb.text}</span>}
    </>
  );
}
