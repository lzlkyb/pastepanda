import { MobileSheet } from "../src-mobile/ui/MobileSheet";
import { RcPairCard } from "../src-mobile/devices/RcPairCard";
import devices from "../src-mobile/devices/RcDevices.module.css";
import { Monitor, ShieldCheck, History, Palette, HelpCircle, Hand, ChevronRight } from "lucide-react";
import { MobilePage } from "../src-mobile/ui/MobilePage";
import ui from "../src-mobile/ui/MobileUi.module.css";
import settings from "../src-mobile/settings/RcSettings.module.css";
export function NavigationReviewNotes({ active, busy }: { active: number; busy: boolean }) {
  return (
    <aside className="reviewNotes">
      <h2>保留熟悉的界面，重做切换规则</h2>
      <p>页面内容、图标、配色和提示沿用现有组件。这一稿只验证分页与导航行为。</p>
      <ol>
        <li>
          <strong>滑动由浏览器承载</strong>
          <span>横向翻页与纵向滚动分别交给实际滚动容器。</span>
        </li>
        <li>
          <strong>后台请求不抢页面</strong>
          <span>先到文件或设置，再点上方「模拟后台请求」。只有点「查看」才跳转。</span>
        </li>
        <li>
          <strong>落定后确认当前页</strong>
          <span>指示背景跟随位移，当前页与可操作内容在整页停稳后确认。</span>
        </li>
        <li>
          <strong>页面保持原来的状态</strong>
          <span>文件页滚到底、换一个传输对象，再切走切回检查。</span>
        </li>
        <li>
          <strong>弹层独立处理</strong>
          <span>打开添加电脑或设备选择，背景分页锁定。</span>
        </li>
      </ol>
      <p className="reviewFootnote">
        电脑浏览器请用底部导航，触屏可直接左右滑。此稿未通过真机手感验收，不代表已修复正式 App。
      </p>
      <output aria-live="polite">
        当前：{["设备", "文件", "设置"][active]} · {busy ? "切换中" : "已落定"}
      </output>
    </aside>
  );
}
export function PrototypeSettings({
  enabled,
  dark,
  setEnabled,
  setSheet,
}: {
  enabled: boolean;
  dark: boolean;
  setEnabled: (value: boolean) => void;
  setSheet: (title: string) => void;
}) {
  const row = (Icon: typeof Monitor, title: string, detail: string) => (
    <button type="button" className={settings.row} onClick={() => setSheet(title)}>
      <Icon size={22} aria-hidden="true" />
      <span className={settings.rowText}>
        <strong>{title}</strong>
        <small>{detail}</small>
      </span>
      <ChevronRight size={18} aria-hidden="true" />
    </button>
  );
  return (
    <MobilePage title="设置" subtitle="按自己的习惯使用 PastePanda">
      <h2 className={ui.sectionHeading}>连接与记录</h2>
      <div className={ui.group}>
        <div className={settings.row}>
          <ShieldCheck size={22} aria-hidden="true" />
          <span className={settings.rowText}>
            <strong>远程通道</strong>
            <small>{enabled ? "可连接电脑和传输文件；暂不支持被控" : "已关闭连接"}</small>
          </span>
          <button
            type="button"
            role="switch"
            aria-label="远程通道"
            aria-checked={enabled}
            className={`${settings.switch} ${enabled ? settings.switchOn : ""}`}
            onClick={() => setEnabled(!enabled)}
          >
            <span />
          </button>
        </div>
        {row(History, "会话历史", "查看连接时间和会话时长")}
      </div>
      <h2 className={ui.sectionHeading}>使用偏好</h2>
      <div className={ui.group}>
        {row(Palette, "外观", dark ? "深色" : "浅色")}
        {row(HelpCircle, "手势使用指南", "点击、长按、缩放和滚动")}
        {row(Hand, "触摸演示", "在测试画面练习，不连接电脑")}
      </div>
      <p className={settings.footer}>PastePanda · 安全连接，随身使用</p>
    </MobilePage>
  );
}

export function PrototypeSheet({
  sheet,
  peer,
  names,
  setSheet,
  setPeer,
  dark,
  setTheme,
  example,
  go,
}: {
  sheet: string | null;
  peer: string;
  names: string[];
  setSheet: (value: string | null) => void;
  setPeer: (value: string) => void;
  dark: boolean;
  setTheme: () => void;
  example: () => void;
  go: (index: number) => void;
}) {
  return (
    <MobileSheet open={!!sheet} title={sheet || "面板"} onClose={() => setSheet(null)}>
      {sheet === "添加电脑" ? (
        <RcPairCard onPaired={() => setSheet(null)} />
      ) : sheet === "选择设备" ? (
        <div className={devices.peerPick}>
          {names.map((name) => (
            <button
              className={devices.peerChip}
              key={name}
              onClick={() => {
                setPeer(name);
                setSheet(null);
              }}
            >
              {name}
              {peer === name ? " · 已选" : ""}
            </button>
          ))}
        </div>
      ) : sheet === "外观" ? (
        <button className={ui.primary} onClick={setTheme}>
          {dark ? "切换浅色" : "切换深色"}
        </button>
      ) : sheet === "设备操作" ? (
        <div className={devices.pairCard}>
          <p className={ui.description}>{peer} · 示例设备</p>
          <button
            className={ui.primary}
            onClick={() => {
              setSheet(null);
              example();
            }}
          >
            远程控制
          </button>
          <button
            className={ui.secondary}
            onClick={() => {
              setSheet(null);
              example();
            }}
          >
            观看画面
          </button>
          <button
            className={ui.secondary}
            onClick={() => {
              setSheet(null);
              go(1);
            }}
          >
            传文件
          </button>
        </div>
      ) : (
        <p className={ui.description}>这是交互稿的示例面板。正式功能沿用当前 App，本次只调整导航与滑动。</p>
      )}
    </MobileSheet>
  );
}
