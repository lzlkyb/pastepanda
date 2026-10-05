import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ChevronRight, History, Palette, Hand, ShieldCheck, HelpCircle } from "lucide-react";
import type { UseRc } from "@/hooks/useRc";
import { MobilePage } from "../ui/MobilePage";
import { MobileSheet } from "../ui/MobileSheet";
import { MobileToast } from "../ui/MobileToast";
import { MobileUpdateSection } from "./MobileUpdateSection";
import type { MobileAppearance } from "../ui/useMobileAppearance";
import { RcMobileHistory } from "./RcMobileHistory";
import ui from "../ui/MobileUi.module.css";
import styles from "./RcSettings.module.css";

export function RcSettingsView({
  rc,
  onOpenSandbox,
  appearance = "system",
  onAppearance,
  active = true,
  onErrorScopeChange,
  pageNotice,
}: {
  rc: UseRc;
  onOpenSandbox: () => void;
  appearance?: MobileAppearance;
  onAppearance?: (value: MobileAppearance) => void;
  active?: boolean;
  onErrorScopeChange?: (owned: boolean) => void;
  pageNotice?: ReactNode;
}) {
  const [panel, setPanel] = useState<"history" | "appearance" | "help" | null>(null);
  const [notice, setNotice] = useState("");
  const dismissNotice = useCallback(() => setNotice(""), []);
  const ownsError = active && panel === "history";
  useEffect(() => {
    onErrorScopeChange?.(ownsError);
    return () => onErrorScopeChange?.(false);
  }, [ownsError, onErrorScopeChange]);
  const enabled = rc.status?.enabled ?? null;
  const appearanceLabel = { system: "跟随系统", light: "浅色", dark: "深色" };
  const toggle = async () => {
    if (enabled === null || rc.busy) return;
    setNotice("");
    if (await rc.setEnabled(!enabled)) setNotice(enabled ? "远程通道已关闭" : "远程通道已开启");
  };
  return (
    <MobilePage title="设置" subtitle="按自己的习惯使用 PastePanda" pageNotice={pageNotice}>
      {active && notice && <MobileToast tone="success" title={notice} onDismiss={dismissNotice} />}
      <div className={styles.settingsLayout}>
      <section>
      <h2 className={ui.sectionHeading}>连接与记录</h2>
      <div className={ui.group}>
        <div className={styles.row}>
          <ShieldCheck size={22} aria-hidden="true" />
          <span className={styles.rowText}>
            <strong>远程通道</strong>
            <small>{enabled === null ? "状态未知" : enabled ? "可连接电脑和传输文件；暂不支持被控" : "已关闭连接"}</small>
          </span>
          {enabled !== null && (
            <button
              type="button"
              role="switch"
              aria-label="远程通道"
              aria-checked={enabled}
              className={`${styles.switch} ${enabled ? styles.switchOn : ""}`}
              disabled={rc.busy}
              onClick={() => void toggle()}
            >
              <span />
            </button>
          )}
        </div>
        <button className={styles.row} type="button" onClick={() => setPanel("history")}>
          <History size={22} aria-hidden="true" />
          <span className={styles.rowText}>
            <strong>会话历史</strong>
            <small>查看连接时间和会话时长</small>
          </span>
          <ChevronRight size={18} aria-hidden="true" />
        </button>
      </div>
      </section>
      <section>
      <h2 className={ui.sectionHeading}>使用偏好</h2>
      <div className={ui.group}>
        <button className={styles.row} type="button" onClick={() => setPanel("appearance")}>
          <Palette size={22} aria-hidden="true" />
          <span className={styles.rowText}>
            <strong>外观</strong>
            <small>{appearanceLabel[appearance]}</small>
          </span>
          <ChevronRight size={18} aria-hidden="true" />
        </button>
        <button className={styles.row} type="button" onClick={() => setPanel("help")}>
          <HelpCircle size={22} aria-hidden="true" />
          <span className={styles.rowText}>
            <strong>手势使用指南</strong>
            <small>点击、长按、缩放和滚动</small>
          </span>
          <ChevronRight size={18} aria-hidden="true" />
        </button>
        <button className={styles.row} type="button" onClick={onOpenSandbox}>
          <Hand size={22} aria-hidden="true" />
          <span className={styles.rowText}>
            <strong>触摸演示</strong>
            <small>在测试画面练习，不连接电脑</small>
          </span>
          <ChevronRight size={18} aria-hidden="true" />
        </button>
      </div>
      </section>
      </div>
      <MobileUpdateSection />
      <p className={styles.footer}>PastePanda · 安全连接，随身使用</p>
      <MobileSheet open={active && panel === "history"} title="会话历史" onClose={() => setPanel(null)}>
        {/* 弹层收起会卸载；每次打开重新读取，避免显示过期的会话记录。 */}
        {active && panel === "history" && <RcMobileHistory rc={rc} />}
      </MobileSheet>
      <MobileSheet
        open={active && panel === "appearance"}
        title="外观"
        description="仅调整这台手机的显示外观。"
        onClose={() => setPanel(null)}
      >
        <div className={styles.choices} role="radiogroup" aria-label="显示外观">
          {(["system", "light", "dark"] as const).map((value) => (
            <button
              type="button"
              role="radio"
              aria-checked={appearance === value}
              key={value}
              className={appearance === value ? ui.primary : ui.secondary}
              onClick={() => onAppearance?.(value)}
            >
              {appearanceLabel[value]}
            </button>
          ))}
        </div>
      </MobileSheet>
      <MobileSheet open={active && panel === "help"} title="手势使用指南" onClose={() => setPanel(null)}>
        <div className={styles.guide}>
          <p>
            <strong>触控板模式（默认）</strong>单指划动移动指针，点按点击指针所在位置，连续点按两次可双击。
          </p>
          <p>
            <strong>直接点击模式</strong>点击画面中的目标即可操作。在会话工具栏的「触控板／直接点击」中切换模式。
          </p>
          <p>
            <strong>长按</strong>唤出右键菜单；长按后移动可拖动。
          </p>
          <p>
            <strong>双指移动</strong>滚动电脑页面；双指捏合调整手机中的画面大小。
          </p>
          <p>
            <strong>键盘与横屏</strong>
            会话工具栏可打开键盘；画面面板可切换横竖屏或恢复缩放。横屏工具栏收起后，点击右上角「工具」展开。
          </p>
        </div>
      </MobileSheet>
    </MobilePage>
  );
}
