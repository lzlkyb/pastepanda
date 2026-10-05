import { useCallback, useRef, useState } from "react";
import { FolderOpen, Monitor, Settings2 } from "lucide-react";
import { useRc } from "@/hooks/useRc";
import { useRcFile } from "@/hooks/useRcFile";
import { useRcStore } from "@/stores/rcStore";
import { TouchSandbox } from "./dev/TouchSandbox";
import { RcDevicesView } from "./devices/RcDevicesView";
import { RcFilesView } from "./devices/RcFilesView";
import { rcErrorText } from "./devices/rcErrorText";
import { RcMobileSession } from "./session/RcMobileSession";
import { RcSettingsView } from "./settings/RcSettingsView";
import { MobileNotice } from "./ui/MobileNotice";
import { MobileUpdateBanner } from "./ui/MobileUpdateBanner";
import { MobileUpdateProvider } from "./ui/MobileUpdate";
import { useMobileAppearance } from "./ui/useMobileAppearance";
import { useMobileViewport } from "./ui/useMobileViewport";
import { MOBILE_TABS, useMobilePager } from "./ui/useMobilePager";
import ui from "./ui/MobileUi.module.css";
import styles from "./App.module.css";

const TAB_META = {
  devices: { label: "设备", Icon: Monitor },
  files: { label: "文件", Icon: FolderOpen },
  settings: { label: "设置", Icon: Settings2 },
};
const TABS = MOBILE_TABS.map(id => ({ id, ...TAB_META[id] }));

export default function App() {
  const [sandbox, setSandbox] = useState(false);
  const [filePeer, setFilePeer] = useState<string | null>(null);
  const [fileNotice, setFileNotice] = useState<{ text: string; error: boolean } | null>(null);
  const [errorOwners, setErrorOwners] = useState({ devices: false, settings: false });
  const deviceErrorScope = useCallback((owned: boolean) => setErrorOwners(v => ({ ...v, devices: owned })), []);
  const settingsErrorScope = useCallback((owned: boolean) => setErrorOwners(v => ({ ...v, settings: owned })), []);
  const rc = useRc(true);
  // 应用级订阅让未打开文件页时也能知道有待接收请求；不新增轮询。
  const file = useRcFile();
  const session = useRcStore((s) => s.status?.session ?? null);
  const appearance = useMobileAppearance();
  useMobileViewport();
  const sessionCanvasRef = useRef<HTMLCanvasElement>(null);
  const onFileStatus = useCallback((text: string | null, error = false) => {
    setFileNotice(text ? { text, error } : null);
  }, []);

  const activeSession = session?.phase === "outbound_active";
  const pager = useMobilePager(!sandbox && !activeSession);
  const { tab, selectTab } = pager;
  const pending = session?.phase === "outbound_pending";
  const rcMessage = rc.error ? rcErrorText(rc.error) : null;
  const targetMessage = tab === "devices" && rc.targetsError ? rcErrorText(rc.targetsError) : null;
  const fileMessage = file.error ? rcErrorText(file.error) : null;
  // Background subscriptions can fail for the same unavailable backend. Keep one
  // visible cause, while preserving each page's recovery controls and file requests.
  const repeatedFileError = !!fileMessage && (fileMessage === rcMessage || fileMessage === targetMessage);
  // 后台申请只显示角标和提示，不抢用户正在使用的页面。
  const inboundCount = activeSession ? 0 : (rc.status?.pending?.length ?? 0);
  // 通知保留在标题之后，后台失败也不能把页面身份挤出首屏。
  const pageNotice = rc.error && rcMessage !== (tab === "files" ? fileMessage : targetMessage) && !(tab !== "files" && errorOwners[tab])
    ? <MobileNotice error onDismiss={rc.clearError} title="操作未能完成" detail={rcErrorText(rc.error)} /> : null;
  // 文件状态通知的关闭入口只给「纯状态」内容：错误与待确认请求的关闭入口在文件页，
  // 跨页 X 掉会让用户以为已处理。dismissing 只清跨页镜像，文件页内的状态不受影响。
  const fileNoticeDismissable = !!fileNotice && !fileNotice.error && file.asks.length === 0 && !file.error;
  return (
    <MobileUpdateProvider>
      <>
      {sandbox && <TouchSandbox onExit={() => setSandbox(false)} />}
      {!sandbox && activeSession && (
        <RcMobileSession
          key={session.id}
          title={session.display_name || session.peer_name}
          subtitle={session.capability === "control" ? "控制中" : "观看中"}
          canvasRef={sessionCanvasRef}
          sessionId={session.id}
          qualityHint={rc.status?.quality}
          status={rc.status}
          canControl={session.capability === "control"}
          endError={rc.error}
          ending={rc.busy}
          onEnd={() => void rc.end()}
          file={file}
        />
      )}
      <div className={styles.root} hidden={sandbox || activeSession}>
        <main className={styles.pane}>
          <div ref={pager.contentRef} className={styles.tabContent} {...pager.events}>
            {/* Three unique page instances retain scroll and in-flight operations; hidden pages are inert. */}
            {TABS.map(({ id, label }) => (
              <section
                key={id}
                className={styles.pagePane}
                aria-label={label}
                aria-hidden={tab !== id || sandbox || activeSession}
                inert={tab !== id || sandbox || activeSession}
              >
                {id === "devices" && (
                  <RcDevicesView
                    pageNotice={tab === id ? pageNotice : undefined}
                    rc={rc}
                    session={session}
                    active={tab === id && !sandbox && !activeSession}
                    onErrorScopeChange={deviceErrorScope}
                    onSendFiles={(nodeId) => {
                      setFilePeer(nodeId);
                      selectTab("files");
                    }}
                  />
                )}
                {id === "files" && (
                  <RcFilesView
                    pageNotice={tab === id ? pageNotice : undefined}
                    rc={rc}
                    initialPeer={filePeer}
                    active={tab === "files" && !sandbox && !activeSession}
                    onShowDevices={() => selectTab("devices")}
                    onPeerChange={setFilePeer}
                    onStatus={onFileStatus}
                  />
                )}
                {id === "settings" && (
                  <RcSettingsView
                    pageNotice={tab === id ? pageNotice : undefined}
                    rc={rc}
                    active={tab === id && !sandbox && !activeSession}
                    onOpenSandbox={() => setSandbox(true)}
                    appearance={appearance.appearance}
                    onAppearance={appearance.setAppearance}
                    onErrorScopeChange={settingsErrorScope}
                  />
                )}
              </section>
            ))}
          </div>
        </main>
        <div className={styles.globalNotice}>
          {tab !== "devices" && inboundCount > 0 && (
            <MobileNotice tone="info" title={`有 ${inboundCount} 个连接请求待处理`}
              detail="继续当前操作，准备好后再查看。"
              action={<button className={ui.textButton} onClick={() => selectTab("devices")}>查看连接请求</button>} />
          )}
          {tab !== "devices" && pending && (
            <MobileNotice
              tone="pending"
              action={
                <>
                  <button className={ui.textButton} disabled={rc.busy} onClick={() => void rc.cancel()}>
                    取消连接
                  </button>
                  <button className={ui.textButton} onClick={() => selectTab("devices")}>
                    查看
                  </button>
                </>
              }
            >
              正在连接 {session.display_name || session.peer_name}，等待电脑确认
            </MobileNotice>
          )}
          {tab !== "files" && (file.asks.length > 0 || file.error && !repeatedFileError || fileNotice) && !pending && (
            <MobileNotice
              error={!!file.error && !repeatedFileError || !!fileNotice?.error}
              onDismiss={fileNoticeDismissable ? () => setFileNotice(null) : undefined}
              action={
                <button className={ui.textButton} onClick={() => selectTab("files")}>
                  查看
                </button>
              }
            >
              {file.error && !repeatedFileError
                ? fileMessage
                : file.asks.length > 0
                  ? `有 ${file.asks.length} 个文件请求待处理`
                  : fileNotice?.text}
            </MobileNotice>
          )}
          {tab !== "settings" && <MobileUpdateBanner />}
        </div>
        <nav className={styles.tabbar} aria-label="主要导航">
          <span ref={pager.selectionRef} className={styles.tabSelection} aria-hidden="true" />
          {TABS.map(({ id, label, Icon }) => (
            <button
              key={id}
              type="button"
              className={`${styles.tab} ${tab === id ? styles.tabActive : ""}`}
              aria-current={tab === id ? "page" : undefined}
              onClick={() => selectTab(id)}
            >
              <span className={styles.tabIcon}>
                <Icon size={23} aria-hidden="true" />
                {((id === "files" && file.asks.length > 0) || (id === "devices" && inboundCount > 0)) && (
                  <span
                    className={styles.badge}
                    aria-label={`${id === "files" ? file.asks.length : inboundCount} 个待处理请求`}
                  >
                    {id === "files" ? file.asks.length : inboundCount}
                  </span>
                )}
              </span>
              <span>{label}</span>
            </button>
          ))}
        </nav>
      </div>
      </>
    </MobileUpdateProvider>
  );
}
