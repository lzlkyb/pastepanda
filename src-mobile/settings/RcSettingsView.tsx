import { useCallback, useEffect, useState, type ReactNode } from "react";
import { ChevronRight, History, Palette, Hand, ShieldCheck, HelpCircle } from "lucide-react";
import type { UseRc } from "@/hooks/useRc";
import { MobileChoice } from "../ui/MobileChoice";
import { MobilePage } from "../ui/MobilePage";
import { MobileSheet } from "../ui/MobileSheet";
import { MobileToast } from "../ui/MobileToast";
import { MobileNotice } from "../ui/MobileNotice";
import { POINTER_MODES, type PointerMode } from "../session/pointerModes";
import { readPointerPreference, savePointerPreference } from "../session/pointerPreference";
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
  const [panel, setPanel] = useState<"history" | "appearance" | "help" | "pointer" | null>(null);
  const [pointerMode, setPointerMode] = useState(readPointerPreference);
  const [pointerResult, setPointerResult] = useState<{ title: string; error?: boolean } | null>(null);
  const [notice, setNotice] = useState("");
  const dismissNotice = useCallback(() => setNotice(""), []);
  const ownsError = active && panel === "history";
  useEffect(() => {
    onErrorScopeChange?.(ownsError);
    return () => onErrorScopeChange?.(false);
  }, [ownsError, onErrorScopeChange]);
  const enabled = rc.status?.enabled ?? null;
  const appearanceLabel = { system: "跟随系统", light: "浅色", dark: "深色" };
  useEffect(() => {
    if (active && panel === "pointer") {
      setPointerMode(readPointerPreference());
      setPointerResult(null);
    }
  }, [active, panel]);
  const pickPointer = (mode: PointerMode) => {
    try {
      savePointerPreference(mode);
      setPointerMode(mode);
      setPointerResult({ title: `默认使用${POINTER_MODES[mode].label}，已保存` });
    } catch {
      setPointerResult({ title: "操作习惯未能保存，请重试；也可在远程会话中切换方式。", error: true });
    }
  };
  const toggle = async () => {
    if (enabled === null || rc.busy) return;
    setNotice("");
    if (await rc.setEnabled(!enabled)) setNotice(enabled ? "远程通道已关闭" : "远程通道已开启");
  };
  return (
    <MobilePage title="设置" subtitle="按自己的习惯使用 PastePanda" pageNotice={pageNotice}>
      {active && notice && <MobileToast placement="flow" tone="success" title={notice} onDismiss={dismissNotice} />}
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
        <button className={styles.row} type="button" onClick={() => setPanel("pointer")}>
          <Hand size={22} aria-hidden="true" />
          <span className={styles.rowText}>
            <strong>操作习惯</strong>
            <small>默认操作方式，在会话中仍可切换</small>
          </span>
          <ChevronRight size={18} aria-hidden="true" />
        </button>
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
        {import.meta.env.DEV && <button className={styles.row} type="button" onClick={onOpenSandbox}>
          <Hand size={22} aria-hidden="true" />
          <span className={styles.rowText}>
            <strong>触摸演示</strong>
            <small>在测试画面练习，不连接电脑</small>
          </span>
          <ChevronRight size={18} aria-hidden="true" />
        </button>}
      </div>
      </section>
      </div>
      <MobileUpdateSection />
      <p className={styles.footer}>PastePanda · 安全连接，随身使用</p>
      <MobileSheet open={active && panel === "pointer"} title="操作习惯"
        description="触控板为初始默认。这里或会话中切换方式，都会记为这部手机下次连接的默认选择。"
        onClose={() => setPanel(null)}
        footer={pointerResult && <MobileNotice compact tone={pointerResult.error ? "error" : "success"} title={pointerResult.title} />}>
        <div className={styles.choices} role="radiogroup" aria-label="默认操作方式">
          {(Object.keys(POINTER_MODES) as PointerMode[]).map(mode => <MobileChoice key={mode} value={mode}
            checked={pointerMode === mode} onSelect={() => pickPointer(mode)} title={POINTER_MODES[mode].label}
            description={POINTER_MODES[mode].description} />)}
        </div>
      </MobileSheet>
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
          {(["system", "light", "dark"] as const).map(value => <MobileChoice key={value} value={value}
            checked={appearance === value} onSelect={() => onAppearance?.(value)} title={appearanceLabel[value]} />)}
        </div>
      </MobileSheet>
      <MobileSheet open={active && panel === "help"} title="手势使用指南" onClose={() => setPanel(null)}>
        <div className={styles.guide}>
          <p>
            <strong>触控板模式（默认）</strong>单指划动移动指针，点按点击指针所在位置，连续点按两次可双击。
          </p>
          <p>
            <strong>直接点击模式</strong>点击画面中的目标即可操作。点会话工具栏中的当前操作方式（如「触控板」），可以切换四种模式。
          </p>
          <p>
            <strong>独立触控板模式</strong>在独立触控区域划动移动指针，点按点击指针处。画面区域只调整手机中的视野，右键、拖拽和滚动使用辅助按钮。
          </p>
          <p>
            <strong>浮动鼠标模式</strong>拖动控制柄定位，指针显示在手指上方。点击、右键、拖拽和滚动使用辅助按钮；画面手势只调整手机中的视野。
          </p>
          <p>
            <strong>长按（触控板与直接点击）</strong>长按松手唤出右键菜单；长按后移动可拖动。
          </p>
          <p>
            <strong>双指移动与缩放</strong>触控板、直接点击模式下，双指移动滚动电脑页面；独立触控板、浮动鼠标模式下，画面上的双指移动只调整本地视野。双指捏合调整手机中的画面大小。
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
