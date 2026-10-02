/**
 * 两个云端弹层（AI / 动作链）共用的件：头部、动作行、搜索框、结果底部。
 *
 * 为什么单独成文件：弹层本身有「四态渲染 + 键盘导航 + 推荐分段 + 渐隐」，
 * 两个弹层再加共用件塞在一个文件里就到 414 行了（规则 7 上限 300）。
 *
 * 动作行的图标必须是**组件**，不是后端返回的 icon 名字符串——
 * 截图窗曾把 `wand-sparkles` 这种字符串直接画进 26px 的格子，实测 23 行里
 * 20 行溢出并压住中文标签。映射表在 `components/transform/TransformIcon.tsx`，
 * 与主窗口枢纽同一张（规则 11.1）。
 */

import type { KeyboardEvent } from "react";
import { ChevronDown, Search } from "lucide-react";
import type { AiActionMeta } from "@/lib/api/ai";
import { AiBadge } from "@/components/AiBadge";
import { TIcon } from "@/components/transform/TransformIcon";

/** 弹层定位：由父组件用 layoutSidePanel 算好（与 OcrDrawer / ResultActions 同一套约定） */
export interface Geometry {
  left: number;
  top: number;
  maxHeight: number;
}

/** 头部副标：两个弹层共用一句，「还没识别到文字」时不谎报行数 */
export function linesSub(lines: number): string {
  return lines > 0 ? `作用于刚识别的 ${lines} 行文字` : "这段选区还没识别到文字";
}

export function PopHead({
  title,
  ai,
  sub,
  onClose,
}: {
  title: string;
  /** 头部一枚 AI 标识（D3：云端标记只在头部出现一次，不再每行挂「✦ 云端」） */
  ai?: boolean;
  sub: string;
  onClose: () => void;
}) {
  return (
    <div className="pop-head">
      <span className="ht">
        <span>
          {title}
          {ai ? " " : ""}
          {ai && <AiBadge size="xs" />}
        </span>
        <span className="sub">{sub}</span>
      </span>
      <span className="sp" />
      <button className="xbtn" onClick={onClose}>
        ✕
      </button>
    </div>
  );
}

/** 结果态底部出口：两个弹层都是「复制结果 / 关闭」，分叉就是下一轮审查的靶子 */
export function PopFoot({
  copied,
  onCopy,
  onClose,
}: {
  copied: boolean;
  onCopy: () => void;
  onClose: () => void;
}) {
  return (
    <div className="pop-foot">
      <button className="fb primary" onClick={onCopy}>
        {copied ? "已复制 ✓" : "复制结果"}
      </button>
      <button className="fb" onClick={onClose}>
        关闭
      </button>
    </div>
  );
}

interface RowProps {
  a: AiActionMeta;
  /** 在可见列表里的序号：↑↓ 用它把焦点行滚进视野 */
  idx: number;
  /** 键盘高亮（↑↓ 走过来的那一行） */
  active?: boolean;
  /** 正在跑这一条 */
  busy?: boolean;
  /** 不可点；原因写在副标题里，不靠 tooltip（规则 15.3） */
  disabled?: boolean;
  onClick: () => void;
}

export function PopRow({ a, idx, active, busy, disabled, onClick }: RowProps) {
  return (
    <button
      type="button"
      data-idx={idx}
      className={`pop-row${active ? " on" : ""}${busy ? " busy" : ""}${disabled ? " disabled" : ""}`}
      aria-disabled={disabled}
      aria-current={active ? "true" : undefined}
      onClick={onClick}
    >
      <span className="ic">
        <TIcon name={a.icon} size={15} />
      </span>
      <span className="tx">
        <span className="lbl">{a.label}</span>
        <span className="dsc">{a.description}</span>
      </span>
    </button>
  );
}

/** 「展开全部 N 项」：外观照抄出口面板的 .act-row.expand，同一句话在同一屏里只该有一种长相 */
export function PopExpandRow({
  count,
  preview,
  onClick,
}: {
  count: number;
  preview: string;
  onClick: () => void;
}) {
  return (
    <button type="button" className="pop-row expand" onClick={onClick}>
      {/* 与出口面板的「展开 N 项」同一枚 ChevronDown：这条行的外观本来就是照抄面板的，
          面板换成组件图标后这里不能留一个 ⋯ 文本字符（同屏两套长相）。 */}
      <span className="ic">
        <ChevronDown size={15} />
      </span>
      <span className="tx">
        <span className="lbl">展开全部 {count} 项</span>
        <span className="dsc">{preview} …</span>
      </span>
    </button>
  );
}

interface SearchProps {
  value: string;
  total: number;
  onChange: (v: string) => void;
  onKeyDown: (e: KeyboardEvent<HTMLInputElement>) => void;
}

export function PopSearch({ value, total, onChange, onKeyDown }: SearchProps) {
  return (
    <div className="pop-search">
      <span className="sic">
        <Search size={13} />
      </span>
      <input
        value={value}
        autoComplete="off"
        spellCheck={false}
        placeholder={`搜索 ${total} 个动作`}
        aria-label="搜索 AI 动作"
        onChange={(e) => onChange(e.target.value)}
        onKeyDown={onKeyDown}
      />
      <span className="kbd">↑↓ Enter Esc</span>
    </div>
  );
}
