/**
 * RcGroupHead — 「远程电脑」小节里一个折叠组的组头。
 *
 * 它顶着 `shared.sSection`，所以是 `.settingsSections` 的直接子节点——搜索过滤和
 * 左菜单滚动都按这个扁平前提工作（见 `settingsSectionsFlatTree.test.tsx`）。
 * 四条卡片闭合规则（`Settings.module.css` 的 `.sRow:has(+ .sSection)` 等）也因此
 * 自动接住收起态的接缝，不需要为新布局另写 CSS。
 *
 * 🔴 `data-label` 是给 `useSettingsSearch` 看的：收起态组头除了名字还挂着一串
 * 状态摘要，直接取 textContent 会让结果条写成「分布在『谁能连进来已配对3…』」。
 * 摘要有数字，所以它**不能**是写死的字面量——计数一律由调用方从真值算出来。
 *
 * 🔴 组头**默认永远可点**（设计稿 §4「主开关关 ⇒ 不可点」这条故意没照做）：折叠是浏览动作，
 * 锁住组头＝主开关一关就谁也展不开组，而组 1 的「配对 / 发起远程」本来就不依赖被远程授权
 * ——把它一起锁掉是砍功能，不是表意「关着」。真正该禁的是控件本身，那由各行的 `disabled` 管。
 *
 * 🔴 唯一例外是 `inert`（搜索态）：展开已由 `rcGroupShouldOpen` 强制，点击既不动屏幕、
 * 也不该偷偷改掉用户退出搜索后的开合态，所以这里连事件处理一起停掉，并让 CSS 撤掉
 * 手型与 hover 底色——反馈必须看得见，不能只是「按了没反应」。
 */
import type { ReactNode } from "react";
import shared from "../../Settings.module.css";
import styles from "../RcSettings.module.css";

export function RcGroupHead({
  label,
  open,
  off,
  inert,
  summary,
  onToggle,
}: {
  /** 组名。≤5 汉字（与 `sections/meta.ts` 的节名同一口径），且不得与任何菜单 label 相同。 */
  label: string;
  open: boolean;
  /** 这组是「被控」配置、此刻通道没开：只变灰提示现状，**仍然可以点开看说明**。 */
  off?: boolean;
  /** 搜索态：展开已被强制，组头停止响应（见上面 🔴 例外那条）。 */
  inert?: boolean;
  summary: ReactNode;
  onToggle: () => void;
}) {
  return (
    <div
      className={`${shared.sSection} ${styles.rcGroupHead}${off ? ` ${styles.rcPanelOff}` : ""}${
        inert ? ` ${styles.rcGroupHeadInert}` : ""
      }`}
      role="button"
      tabIndex={0}
      aria-expanded={open}
      aria-disabled={inert || undefined}
      data-label={label}
      onClick={() => {
        if (!inert) onToggle();
      }}
      onKeyDown={(e) => {
        if (inert) return;
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          onToggle();
        }
      }}
    >
      <span className={styles.rcGroupChev} aria-hidden="true" />
      <span className={styles.rcGroupName}>{label}</span>
      <span className={styles.rcGroupSum}>{summary}</span>
    </div>
  );
}
