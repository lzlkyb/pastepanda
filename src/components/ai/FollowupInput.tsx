/**
 * FollowupInput —— 追问输入框（结果卡下常驻，Enter 或按钮发送）。
 *
 * AiQuickBar 与 TransformCard 两处共用。以前它寄在 AiQuickBar.tsx 里、
 * 由 TransformCard 反向 import，拆子组件时会直接变成环依赖，所以独立成文件。
 *
 * 外壳走共用的 `Composer`（提案 2 单行紧凑）。调用方只有 `className` 一处新增
 * （变换中心那张卡要给自己那 13px 侧距），其余行为不变。
 */
import { useState } from "react";
import { Loader2 } from "lucide-react";
import { Composer } from "@/components/Composer";
import styles from "./FollowupInput.module.css";

export function FollowupInput({
  disabled,
  onSubmit,
  className,
}: {
  disabled: boolean;
  onSubmit: (q: string) => void;
  /**
   * 宿主侧的定位类。两处调用方的容器口径不一样，侧距只能由宿主给：
   * 变换中心那张卡是 `overflow: hidden` 的，Composer 的 3px 焦点外环画在盒外，
   * 不给侧距就会被卡片切掉（见 TransformHub.module.css `.tcFollow`）。
   */
  className?: string;
}) {
  const [val, setVal] = useState("");
  const submit = () => {
    if (!val.trim() || disabled) return;
    onSubmit(val);
    setVal("");
  };
  return (
    <Composer
      className={className ? `${styles.followComposer} ${className}` : styles.followComposer}
      variant="slim"
      value={val}
      onChange={setVal}
      onSubmit={submit}
      disabled={disabled}
      sendDisabled={disabled || !val.trim()}
      placeholder="追问：再短一点 / 翻译成英文…（Enter 发送）"
      ariaLabel="AI 追问"
      /* 🔴 发送钮保留「追问」两个字而不是换成 ↑（设计稿 §2 画的是 ↑）——L2 判的是
         「常驻的图标按钮必须有常驻文字标签」，这一处原本是带字的，换成图标就是往
         回退。带字只让按钮变宽，高度仍是 24 ⇒ 外框仍是稿 §3 量的 36px。
         正在跑的时候仍然换回转圈（原有行为，U1 的 >1s 指示）。 */
      send={disabled ? <Loader2 size={11} className="spin" /> : "追问"}
      sendTitle="发送追问（Enter）"
    />
  );
}
