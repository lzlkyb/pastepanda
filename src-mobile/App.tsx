import { useRef, useState } from "react";
import { useRc } from "@/hooks/useRc";
import { useRcStore } from "@/stores/rcStore";
import styles from "./App.module.css";
import { TouchSandbox } from "./dev/TouchSandbox";
import { RcDevicesView } from "./devices/RcDevicesView";
import { RcFilesView } from "./devices/RcFilesView";
import { RcMobileSession } from "./session/RcMobileSession";
import { RcSettingsView } from "./settings/RcSettingsView";

/**
 * 手机 RC 客户端（手机端规划 P1，P1.5 三页签补齐）。
 *
 * 结构：App 持有 useRc（store 轮询的应用级入口，切页签不断）——
 * - 会话 active（outbound_active）：全屏切 RcMobileSession（触摸/帧泵/音频已验收），
 *   不受页签影响；断开回原页签。
 * - 设备页签：RcDevicesView 三态（空/列表/配对/uno 接入 + pending 卡）。
 * - 文件页签：RcFilesView（rc-file ALPN 取文件 + 传输记录）。
 * - 设置页签：RcSettingsView（通道开关 / 会话历史 / 联调入口）。
 *
 * pending（outbound_pending）不换屏：显示在设备页内（可取消的等待卡），
 * 若用户切走页签，请求继续，confirmed 后 App 这里直接接管换屏。
 */

type Tab = "devices" | "files" | "settings";

const TABS: Array<{ id: Tab; label: string }> = [
  { id: "devices", label: "设备" },
  { id: "files", label: "文件" },
  { id: "settings", label: "设置" },
];

export default function App() {
  const [tab, setTab] = useState<Tab>("devices");
  const [sandbox, setSandbox] = useState(false);
  /** 设备面板「传文件」→ 切到文件页并预选这台设备（页签切换即重挂，initial 够用）。 */
  const [filePeer, setFilePeer] = useState<string | null>(null);
  const rc = useRc(true);
  const session = useRcStore((s) => s.status?.session ?? null);
  const sessionCanvasRef = useRef<HTMLCanvasElement>(null);

  if (sandbox) return <TouchSandbox onExit={() => setSandbox(false)} />;

  // 会话态：全屏会话壳。key = 会话 id，换会话必然重挂（解码器/手势状态清零）。
  if (session?.phase === "outbound_active") {
    return (
      <RcMobileSession
        key={session.id}
        title={session.display_name || session.peer_name}
        subtitle={session.capability === "control" ? "控制中" : "观看中"}
        canvasRef={sessionCanvasRef}
        sessionId={session.id}
        qualityHint={rc.status?.quality}
        canControl={session.capability === "control"}
        onEnd={() => void rc.end()}
      />
    );
  }

  return (
    <div className={styles.root}>
      <main className={styles.pane}>
        {tab === "devices" && (
          <RcDevicesView
            rc={rc}
            session={session}
            onSendFiles={(nodeId) => {
              setFilePeer(nodeId);
              setTab("files");
            }}
          />
        )}
        {tab === "files" && <RcFilesView rc={rc} initialPeer={filePeer} />}
        {tab === "settings" && <RcSettingsView rc={rc} onOpenSandbox={() => setSandbox(true)} />}
      </main>

      <nav className={styles.tabbar}>
        {TABS.map((t) => (
          <button
            key={t.id}
            type="button"
            className={`${styles.tab} ${tab === t.id ? styles.tabActive : ""}`}
            onClick={() => setTab(t.id)}
          >
            {t.label}
          </button>
        ))}
      </nav>
    </div>
  );
}
