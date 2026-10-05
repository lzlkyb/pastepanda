import { NavigationReviewNotes, PrototypeSettings, PrototypeSheet } from "./mobile-navigation-B-panels";
import React, { useState } from "react";
import { createRoot } from "react-dom/client";
import {
  Monitor,
  FolderOpen,
  Settings2,
  ShieldCheck,
  ScanLine,
  KeyRound,
  ChevronRight,
  ChevronDown,
  FolderUp,
  FolderDown,
} from "lucide-react";
import { MobilePage } from "../src-mobile/ui/MobilePage";
import { MobileNotice } from "../src-mobile/ui/MobileNotice";
import app from "../src-mobile/App.module.css";
import ui from "../src-mobile/ui/MobileUi.module.css";
import devices from "../src-mobile/devices/RcDevices.module.css";
import { usePreviewPager } from "./mobile-navigation-B-pager";
import "../src/styles/theme.css";
import "../src-mobile/styles/mobile-base.css";
import "./mobile-navigation-B.css";
const tabs = [
  { label: "设备", Icon: Monitor },
  { label: "文件", Icon: FolderOpen },
  { label: "设置", Icon: Settings2 },
];
const names = ["工作电脑", "家里的电脑", "笔记本电脑"];
function Prototype() {
  const pager = usePreviewPager();
  const [dark, setDark] = useState(false);
  const [request, setRequest] = useState(false);
  const [sheet, setSheet] = useState<string | null>(null);
  const [peer, setPeer] = useState(names[0]);
  const [message, setMessage] = useState("");
  const [enabled, setEnabled] = useState(true);
  const setTheme = () => {
    document.documentElement.dataset.theme = dark ? "ocean" : "midnight";
    setDark(!dark);
  };
  const example = () => setMessage("这是交互设计稿，此操作不会连接电脑或传输文件。");
  return (
    <div className="reviewLayout">
      <header className="reviewHeader">
        <div>
          <h1>手机导航与滑动 · B</h1>
          <p>交互设计稿 · 示例数据</p>
        </div>
        <div className="reviewControls">
          <button type="button" onClick={setTheme}>
            {dark ? "切换浅色" : "切换深色"}
          </button>
          <button type="button" onClick={() => setRequest(true)}>
            模拟后台请求
          </button>
        </div>
      </header>
      <div className="deviceFrame">
        <div className={app.root}>
          <div
            className="nativePager"
            ref={pager.pager}
            onScroll={pager.onScroll}
            aria-label="可左右滑动的页面"
            onClickCapture={(event) => {
              if (pager.moving.current) {
                event.preventDefault();
                event.stopPropagation();
              }
            }}
          >
            {tabs.map(({ label }, index) => (
              <section
                key={label}
                className={`${app.pagePane} prototypePage`}
                aria-label={label}
                aria-hidden={pager.active !== index}
                inert={pager.active !== index}
              >
                {index === 0 && (
                  <MobilePage title="设备" subtitle="你的电脑，随时在身边。">
                    <div className={devices.channel}>
                      <div>
                        <strong>{enabled ? "远程通道已开启" : "远程通道已关闭"}</strong>
                        <p>3 台已配对设备</p>
                      </div>
                      <span>
                        <ShieldCheck size={22} aria-hidden="true" />
                      </span>
                    </div>
                    <div className={devices.actionsRow}>
                      <button className={ui.secondary} onClick={() => setSheet("添加电脑")}>
                        <ScanLine size={19} aria-hidden="true" />
                        添加电脑
                      </button>
                      <button className={ui.secondary} onClick={() => setSheet("无人值守")}>
                        <KeyRound size={19} aria-hidden="true" />
                        无人值守
                      </button>
                    </div>
                    <div className={ui.sectionHead}>
                      <span>已配对设备</span>
                      <button className={ui.textButton} onClick={() => setMessage("示例设备状态已刷新。")}>
                        重新检查
                      </button>
                    </div>
                    <div className={ui.group}>
                      {names.map((name) => (
                        <button
                          key={name}
                          className={devices.deviceCard}
                          onClick={() => {
                            setPeer(name);
                            setSheet("设备操作");
                          }}
                        >
                          <span className={devices.deviceIcon}>
                            <Monitor size={26} aria-hidden="true" />
                          </span>
                          <span className={devices.deviceText}>
                            <strong>{name}</strong>
                            <span className={devices.deviceSub}>
                              Windows · {name === names[2] ? "离线" : "在线"}（示例）
                            </span>
                          </span>
                          <ChevronRight size={18} aria-hidden="true" />
                        </button>
                      ))}
                    </div>
                    <p className={ui.hint}>点设备选择远程控制、观看或传文件。</p>
                    <p className="exampleCaption">以上设备和在线状态均为示例。</p>
                  </MobilePage>
                )}
                {index === 1 && (
                  <MobilePage title="文件" subtitle="不接管画面，也能互传文件。">
                    <button type="button" className={devices.peerSelect} onClick={() => setSheet("选择设备")}>
                      <Monitor size={34} aria-hidden="true" />
                      <span>
                        <small>传输对象</small>
                        <strong>{peer}</strong>
                        <small>Windows（示例）</small>
                      </span>
                      <ChevronDown size={18} aria-hidden="true" />
                    </button>
                    <div className={devices.transferActions}>
                      <button className={devices.primaryBtn} onClick={example}>
                        <FolderUp size={24} aria-hidden="true" />
                        发送文件
                      </button>
                      <button className={devices.ghostBtn} onClick={example}>
                        <FolderDown size={24} aria-hidden="true" />
                        从电脑取回
                      </button>
                    </div>
                    <div className={ui.sectionHead}>
                      <span>传输记录</span>
                      <span>示例数据</span>
                    </div>
                    <ul className={devices.fileTasks}>
                      {[
                        "项目资料.pdf",
                        "界面截图.png",
                        "使用说明.txt",
                        "演示文件.zip",
                        "会议记录.pdf",
                        "设计参考.png",
                        "归档资料.zip",
                        "设备清单.txt",
                      ].map((name, i) => (
                        <li key={name} className={devices.fileTask}>
                          <div className={devices.fileTaskHead}>
                            <span className={devices.fileDir}>{i % 2 ? "接收" : "发送"}</span>
                            <strong className={devices.fileTaskName}>{name}</strong>
                          </div>
                          <div className={devices.fileTaskLine}>已完成 · {peer}</div>
                        </li>
                      ))}
                    </ul>
                    <button className={ui.textButton} onClick={() => setSheet("文件接收位置")}>
                      <FolderOpen size={18} aria-hidden="true" />
                      查看接收位置
                    </button>
                  </MobilePage>
                )}
                {index === 2 && (
                  <PrototypeSettings enabled={enabled} dark={dark} setEnabled={setEnabled} setSheet={setSheet} />
                )}
              </section>
            ))}
          </div>
          <div className={app.globalNotice}>
            {request && (
              <MobileNotice
                tone="info"
                title="示例电脑发来了连接请求"
                detail="继续当前操作，准备好后再查看。"
                onDismiss={() => setRequest(false)}
                action={
                  <button
                    className={ui.textButton}
                    onClick={() => {
                      pager.go(0);
                      setRequest(false);
                      setMessage("已前往设备页查看示例请求，原型不建立连接。");
                    }}
                  >
                    查看
                  </button>
                }
              />
            )}
            {message && <MobileNotice tone="info" title={message} onDismiss={() => setMessage("")} />}
          </div>
          <nav className={app.tabbar} aria-label="主要导航">
            <span className={app.tabSelection} ref={pager.indicator} aria-hidden="true" />
            {tabs.map(({ label, Icon }, index) => (
              <button
                key={label}
                type="button"
                className={`${app.tab} ${pager.active === index ? app.tabActive : ""}`}
                aria-current={pager.active === index ? "page" : undefined}
                onClick={() => pager.go(index)}
              >
                <span className={app.tabIcon}>
                  <Icon size={23} aria-hidden="true" />
                  {index === 0 && request && (
                    <span className={app.badge} aria-label="1 个待处理请求">
                      1
                    </span>
                  )}
                </span>
                <span>{label}</span>
              </button>
            ))}
          </nav>
        </div>
      </div>
      <NavigationReviewNotes active={pager.active} busy={pager.busy} />
      <PrototypeSheet
        sheet={sheet}
        peer={peer}
        names={names}
        setSheet={setSheet}
        setPeer={setPeer}
        dark={dark}
        setTheme={setTheme}
        example={example}
        go={pager.go}
      />
    </div>
  );
}
createRoot(document.getElementById("root")!).render(<Prototype />);
