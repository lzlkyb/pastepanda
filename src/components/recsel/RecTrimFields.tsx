/**
 * RecTrimFields — 裁剪起止点的读数芯片 + **视觉隐藏**的原生 range（设计稿 §05）。
 *
 * 分工（这是本文件存在的全部理由）：
 * - 看得见的是两枚芯片：`起点 00:03.2` / `终点 00:14.6`。它们**不是**滑杆，
 *   是「读数 + 焦点落点」——点它即把焦点交给被 `<label>` 关联的那个原生 range。
 * - 看不见的是两枚原生 `<input type="range">`：`role="slider"`、方向键、Home/End、
 *   `aria-valuetext` 全部由浏览器给，读屏听到的也是它们。`.rec-rangeback` 用
 *   `clip-path: inset(50%)` 藏起来（不是 `display:none`——那样连焦点和键盘一起没了）。
 *
 * 一个控件只报一次：芯片本身不是 focusable（label 不是控件），所以 Tab 只停在
 * 那两枚 range 上，焦点环画在芯片上（`.rec-pv-chip:focus-within`）。
 *
 * 方向键跨过**实际关键帧**而不是移动 1ms 再被吸回原处（改前那条 `change()` 的语义，
 * 原样保留：吸附段内逐毫秒移动等于按键没反应）。
 */
import type { KeyboardEvent } from "react";
import { snapTrimRange, type TrimRange } from "./trimSnap";
import { trimClock } from "./trimClock";

export function TrimFields({
  duration,
  keyframes,
  value,
  disabled,
  keepInfo,
  onChange,
}: {
  duration: number;
  keyframes: number[];
  /** 已解析的保留段（调用方负责把 null 折成 0 – duration）。 */
  value: TrimRange;
  disabled: boolean;
  /** 右侧那格保持文案：保留时长，或「为什么现在不能裁」的原因。 */
  keepInfo: string;
  onChange: (range: TrimRange) => void;
}) {
  const change = (side: "inMs" | "outMs", ms: number) => {
    const snapped = snapTrimRange(keyframes, duration, side === "inMs" ? ms : value.inMs, side === "outMs" ? ms : value.outMs);
    if (snapped.outMs > snapped.inMs) onChange(snapped);
  };
  const key = (side: "inMs" | "outMs") => (event: KeyboardEvent<HTMLInputElement>) => {
    if (!["ArrowLeft", "ArrowRight", "ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
    event.preventDefault();
    const points = [...new Set([0, ...keyframes, duration])].sort((a, b) => a - b);
    const forward = event.key === "ArrowRight" || event.key === "ArrowUp";
    const ms =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? duration
          : forward
            ? (points.find((point) => point > value[side]) ?? duration)
            : (points.filter((point) => point < value[side]).pop() ?? 0);
    change(
      side,
      Math.min(side === "inMs" ? value.outMs - 1 : duration, Math.max(side === "outMs" ? value.inMs + 1 : 0, ms)),
    );
  };
  /**
   * 两枚芯片除侧别外完全同构：同一条接线、同一套键盘语义，只有 side 不同。
   * `name` 是**可访问名**（`裁剪起点` / `裁剪终点`，与改前一字不差——读屏用户认的是它）；
   * 芯片上那两个字是视觉标签（`起点` / `终点`）。两者故意不同名：
   * 可访问名是「哪个控件」，视觉标签是「哪一端」，把前者缩成两个字会让读屏听见两个 `起点`。
   */
  const chip = (side: "inMs" | "outMs", name: string, visible: string) => (
    <label className="rec-pv-chip">
      <span className="k">{visible}</span>
      <output>{trimClock(value[side])}</output>
      <input
        className="rec-rangeback"
        aria-label={name}
        type="range"
        min={0}
        max={duration}
        step={1}
        value={value[side]}
        disabled={disabled}
        aria-valuetext={trimClock(value[side])}
        onChange={(event) => change(side, Number(event.target.value))}
        onKeyDown={key(side)}
      />
    </label>
  );
  return (
    <div className="rec-pv-trimrow">
      {chip("inMs", "裁剪起点", "起点")}
      {chip("outMs", "裁剪终点", "终点")}
      <span className="rec-pv-sp" />
      <span className="rec-pv-keep">{keepInfo}</span>
    </div>
  );
}
