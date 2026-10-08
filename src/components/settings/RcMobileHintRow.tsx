/**
 * RcMobileHintRow — 「远程电脑」小节里的手机端 App 情境化提示（块3）。
 *
 * 触发口径刻意用**状态**而非**事件**：只要本机已配对过远程设备（`targets.length > 0`），
 * 就在「远程电脑」节里出现一行「手机装 PastePanda 就能随时连这台电脑」。
 * 之所以不监听「刚刚配对成功那一刻」——桌面端配对成功分散在 4 条 UI 路径（短码 / 粘贴码 /
 * 附近 / A2 交换），按规则 11.1 要四处同挂才算收口，侵入刚审计过的 RC 内部不划算；
 * 而 `targets` 是本节已在渲染的同一份数据（`RcSection` 挂载即 `refreshTargets`），单一真源、
 * 常驻可发现，比一闪而过的 toast 更稳。
 *
 * 一次性打扰：点 × 后写 localStorage 标记，此后不再出现（规则 9 边界 + 规则 15.1 反馈同域：
 * 关闭按钮和它关掉的东西在同一行里）。点击整行 → 跳到「关于 → 手机 App 下载卡」。
 */
import { useState, type MouseEvent as ReactMouseEvent } from "react";
import { X, ChevronRight } from "lucide-react";
import { openSettingsTab } from "@/lib/openSettings";
import { SettingTile } from "./ToggleRow";
import shared from "../Settings.module.css";
import styles from "./RcSettings.module.css";

export const MOBILE_HINT_DISMISS_KEY = "pastepanda_mobile_app_hint_dismissed";

export function isMobileHintDismissed(): boolean {
  try {
    return localStorage.getItem(MOBILE_HINT_DISMISS_KEY) === "1";
  } catch {
    return false;
  }
}

export function RcMobileHintRow() {
  const [dismissed, setDismissed] = useState(isMobileHintDismissed);

  if (dismissed) return null;

  const gotoAbout = () => openSettingsTab("about");
  const dismiss = (e: ReactMouseEvent) => {
    e.stopPropagation();
    try {
      localStorage.setItem(MOBILE_HINT_DISMISS_KEY, "1");
    } catch {
      /* 隐私模式下写不进就算了：行仍在，只是下次还会提示 */
    }
    setDismissed(true);
  };

  return (
    <div
      className={shared.sRow}
      role="button"
      tabIndex={0}
      onClick={gotoAbout}
      onKeyDown={(e) => {
        // 🔴 只在按键落在**整行本身**时接管：嵌套的 × 按钮聚焦时按 Enter/空格，
        // 若这里照旧 preventDefault，会取消按钮自身的激活 ⇒ × 变成只能鼠标点，
        // 且 Enter 反而误跳关于页。放行 e.target≠本行，让按钮走它自己的键盘语义。
        if (e.target !== e.currentTarget) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          gotoAbout();
        }
      }}
      style={{ cursor: "pointer" }}
    >
      <SettingTile hue="paste">📱</SettingTile>
      <div className={shared.sRowBody}>
        <div className={shared.sRowLabel}>想在手机上连这台电脑？</div>
        <div className={shared.sRowDesc}>装 PastePanda 安卓版，配对后即可随时收发粘贴、远程取用</div>
      </div>
      {/* 行末 last-child 会吃 min-width:72，套 span 让 × 与 › 保持原尺寸贴右 */}
      <span className={styles.rcHintTrail}>
        <button
          type="button"
          className={styles.rcHintClose}
          aria-label="不再提示"
          onClick={dismiss}
        >
          <X size={14} />
        </button>
        <ChevronRight size={16} color="var(--text-muted)" />
      </span>
    </div>
  );
}
