/**
 * KbForgetDialog — 「删除此设备」的二次确认。
 *
 * 从 `KbSyncPanel` 拆出来（规则 #7 体量红线），顺带补上它原本缺的两件模态标配：
 * `FocusTrap` 与 Esc。
 *
 * 🔴 Esc 必须走**捕获期 + `stopPropagation()`**：App.tsx 的 Esc 分层链里有一条
 * `if (showSettings) closeSettings()`，而本确认框就开在设置页上——不接住这一下，
 * 按 Esc 关掉的是整个设置页（同 `KbPairDialog` 的教训，写法照它）。
 * 接法走公共 hook `useDialogEscape`（输入法合成态、嵌套确认框让路都在那边，规则 #11.1）。
 *
 * 与拆分前唯一的视觉差别：正文 12.5px → 12px（U5 只认五档字号，见 `.kbForgetBody`）。
 */
import { createPortal } from "react-dom";
import { FocusTrap } from "@/components/FocusTrap";
import { useDialogEscape } from "@/hooks/useDialogEscape";
import styles from "./Lan.module.css";

export function KbForgetDialog({ name, busy, onCancel, onConfirm }: {
  name: string;
  busy: boolean;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  useDialogEscape(onCancel);

  /**
   * 🔴 必须 portal 到 body：本组件的 DOM 父链穿过 `.settingsContent`（**滚动容器**）。
   * `position: fixed` 只决定画在哪儿，不改变 DOM 父子关系 —— 滚轮落在遮罩上仍会
   * 沿祖先链滚到设置列表；`.dialog-backdrop` 自己那句 `overscroll-behavior: contain`
   * 拦不住它，因为那个属性只对**真滚动容器**生效，遮罩不是。
   * 投到 body 后父链里没有滚动容器了，行为与 `PromptDialog` / `ConfirmDialog` 一致。
   */
  return createPortal(
    <div className="dialog-backdrop" onClick={onCancel}>
      <FocusTrap initialFocus="[data-autofocus]">
        <div className="dialog-box dialog-solid w420" onClick={(e) => e.stopPropagation()}>
          <div className="dialog-header"><h2 className="dialog-title">删除「{name}」？</h2></div>
          <div className={`dialog-body ${styles.kbForgetBody}`}>
            <p>
              本机不再与它同步，已同步过来的笔记<b>不会被删</b>；要恢复得重新配对。
            </p>
            <p className={styles.kbForgetMuted}>
              若只想暂时不同步，用旁边的「启用」开关即可，无需删除。
            </p>
            {/* 说清后果：只删一边的话对方会一直白拨，用户看到「连不上」会以为是 bug */}
            <p className={styles.kbForgetMuted}>
              ❗ 对方那台机器上<b>还留着这台的记录</b>，它会继续尝试连接并被拒绝。
              想彻底断开，请在两边都删除一次。
            </p>
          </div>
          <div className="dialog-footer">
            {/* 安全默认：取消是这条路上唯一不丢东西的选择，所以默认焦点和 Esc 都归它 */}
            <button className="btn-secondary" onClick={onCancel} autoFocus data-autofocus>取消</button>
            <button className="btn-danger" disabled={busy} onClick={onConfirm}>删除此设备</button>
          </div>
        </div>
      </FocusTrap>
    </div>,
    document.body
  );
}
