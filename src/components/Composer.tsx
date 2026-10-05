/**
 * Composer —— 「提问框」这一类控件的共用外壳（渐变光晕 + 发送钮）。
 *
 * 范围是**三处**，不是全库输入框：知识库追问、AI 追问、变换中心指令条。
 * 其余 20+ 处（顶栏搜索、设置字段、截图标注…）是 32–38px 的定位控件，不在这一次里。
 * 依据与实测：design/PastePanda-提问框渐变光晕Composer-设计稿.html。
 *
 * 两态：`full` = 提案 1 完整解剖（输入在上，提示 + 发送在下，恒 68px）；
 *       `slim` = 提案 2 单行紧凑（恒 36px）。
 *
 * 提交语义**故意不在这儿收口**：三处对「空值能不能提交」的既有行为不同——
 * KB 与 AI 空值不提交，指令条空值提交要给「没看懂」的反馈。所以守卫留在各宿主里，
 * 本组件只管渲染与键盘（IME / Shift+Enter）。
 */
import {
  useImperativeHandle,
  useRef,
  type KeyboardEvent,
  type ReactNode,
  type Ref,
  type RefObject,
} from "react";
import { useAutoGrow } from "@/hooks/useAutoGrow";
import styles from "./Composer.module.css";

/** 宿主需要的两个动作：指令条未命中时要把原文选中，方便直接改 */
export type ComposerHandle = {
  focus: () => void;
  select: () => void;
};

export function Composer({
  value,
  onChange,
  onSubmit,
  placeholder,
  ariaLabel,
  multiline = false,
  variant = "full",
  disabled = false,
  sendDisabled = false,
  maxLength,
  hint,
  lead,
  send,
  sendLabel,
  sendTitle,
  className,
  containerRef,
  ref,
}: {
  value: string;
  onChange: (v: string) => void;
  onSubmit: () => void;
  placeholder: string;
  ariaLabel: string;
  /** 会写长句的地方用 `textarea`（自动增高），加速器用 `input` */
  multiline?: boolean;
  /** `full` = 提案 1；`slim` = 提案 2 */
  variant?: "full" | "slim";
  /** 输入本身不可用（回答中 / AI 未启用），发送钮跟着禁用 */
  disabled?: boolean;
  /** 发送钮的禁用态单独给：指令条空值也要能点（点了才有「没看懂」的反馈） */
  sendDisabled?: boolean;
  maxLength?: number;
  /** full 那行左侧的常驻提示（可放文字或已有的范围说明） */
  hint?: ReactNode;
  /** slim 左侧的图标位，样式由宿主自己的类提供 */
  lead?: ReactNode;
  send: ReactNode;
  /** 图标按钮才需要（L2 的补偿）；带文字的宿主留给可见文字当标签，别再用 aria-label 盖掉它 */
  sendLabel?: string;
  sendTitle?: string;
  /** 宿主用来挂 `--composer-fs`（字号）与外边距的类 */
  className?: string;
  /** 传给 `useAutoGrow`：增高上限跟这块面板的高走 */
  containerRef?: RefObject<HTMLElement | null>;
  ref?: Ref<ComposerHandle>;
}) {
  const lineRef = useRef<HTMLInputElement | null>(null);
  // 单行时 enabled=false，effect 直接返回；不条件调用 hook（规则：hook 顺序稳定）
  const growRef = useAutoGrow(value, { enabled: multiline, containerRef });

  useImperativeHandle(ref, () => ({
    focus: () => (multiline ? growRef.current : lineRef.current)?.focus(),
    select: () => (multiline ? growRef.current : lineRef.current)?.select(),
  }));

  const submit = () => {
    if (disabled) return;
    onSubmit();
  };

  const onKeyDown = (e: KeyboardEvent<HTMLInputElement | HTMLTextAreaElement>) => {
    if (e.key !== "Enter" || e.nativeEvent.isComposing) return;
    // 输入法选字的 Enter 不能当提交；Shift+Enter 只 multiline 有换行可留
    if (multiline && e.shiftKey) return;
    e.preventDefault();
    submit();
  };

  const boxClass = `${variant === "full" ? styles.composer : styles.composerSlim}${className ? ` ${className}` : ""}`;
  const field = multiline ? (
    <textarea
      ref={growRef}
      className={styles.composerInput}
      value={value}
      rows={1}
      maxLength={maxLength}
      disabled={disabled}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
    />
  ) : (
    <input
      ref={lineRef}
      className={styles.composerInput}
      value={value}
      maxLength={maxLength}
      disabled={disabled}
      placeholder={placeholder}
      aria-label={ariaLabel}
      onChange={(e) => onChange(e.target.value)}
      onKeyDown={onKeyDown}
    />
  );
  const sendButton = (
    <button
      type="button"
      className={styles.composerSend}
      onClick={submit}
      disabled={sendDisabled}
      aria-label={sendLabel}
      title={sendTitle}
    >
      {send}
    </button>
  );

  if (variant === "full") {
    return (
      <div className={boxClass}>
        {field}
        <div className={styles.composerBar}>
          <span className={styles.composerHint}>{hint}</span>
          {sendButton}
        </div>
      </div>
    );
  }
  return (
    <div className={boxClass}>
      {lead}
      {field}
      {sendButton}
    </div>
  );
}
