/**
 * AI 处理弹层：真图标 + 搜索 + 推荐分段 + 键盘导航 + 底部渐隐。
 *
 * 纯展示组件：不发请求、不做敏感内容确认——那些路径上有红线判断（规则 16），
 * 必须留在能看到全局状态的父组件里。
 *
 * 排序不在这儿实现：走 `lib/screenshot/aiPopActions.ts` 的 `buildAiPopList`，
 * 它与主窗口枢纽共用同一个打分函数（有守卫单测钉住）。
 */

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as RKEvent } from "react";
import type { AiActionMeta } from "@/lib/api/ai";
import type { TransformContext } from "@/lib/transforms/types";
import { buildAiPopList } from "@/lib/screenshot/aiPopActions";
import {
  linesSub,
  PopExpandRow,
  PopFoot,
  PopHead,
  PopRow,
  PopSearch,
  type Geometry,
} from "./AiPopList";

/** AI 弹层运行状态（三态 + 确认） */
export interface PopRun {
  status: "idle" | "running" | "ok" | "error" | "confirm";
  content?: string;
  message?: string;
  meta?: string;
  confirmReason?: string;
}

interface Props extends Geometry {
  /** 刚识别出的文字行数 */
  lines: number;
  /**
   * 打分上下文（内容类型 + 预分析特征）。
   * null = 后端本地分类还没回来：此时**不排推荐段**，按后端清单原序平铺——
   * 拿猜出来的类型去打分，排错序比暂时没推荐更难解释。
   */
  ctx: TransformContext | null;
  res: PopRun | null;
  actions: AiActionMeta[];
  busyId: string | null;
  copied: boolean;
  onRun: (a: AiActionMeta) => void;
  /** needsConfirm 后用户点「继续」 */
  onContinue: () => void;
  onCopy: () => void;
  onClose: () => void;
}

export function AiPopover({
  left,
  top,
  maxHeight,
  lines,
  ctx,
  res,
  actions,
  busyId,
  copied,
  onRun,
  onContinue,
  onCopy,
  onClose,
}: Props) {
  const [query, setQuery] = useState("");
  const [expanded, setExpanded] = useState(false);
  // ↑↓ 的落点，-1 = 还没进键盘导航。换搜索词 / 展开态时归零，
  // 否则残留序号会指到另一条动作上，Enter 就跑错动作。
  const [active, setActive] = useState(-1);
  const [scrolled, setScrolled] = useState(false);
  const bodyRef = useRef<HTMLDivElement | null>(null);

  const searching = !!query.trim();
  const list = useMemo(() => buildAiPopList(actions, ctx, query), [actions, ctx, query]);

  /** ↑↓ 的遍历域；行上的 data-idx 必须与这里的下标一致 */
  const visible = useMemo(() => {
    // ctx 为 null 时 list.rest 就是原序全清单、rec 为空，所以这里必须带上 !ctx
    if (searching || !ctx) return list.rest;
    return expanded ? [...list.rec, ...list.rest] : list.rec;
  }, [searching, ctx, expanded, list]);

  useEffect(() => setActive(-1), [query, expanded, actions.length]);

  useEffect(() => {
    if (active < 0) return;
    bodyRef.current?.querySelector(`[data-idx="${active}"]`)?.scrollIntoView({ block: "nearest" });
  }, [active]);

  // 底部渐隐只在「真的还能往下滚」时出现，否则就是一个永不消失的假暗示
  const syncFade = () => {
    const el = bodyRef.current;
    if (!el) return;
    setScrolled(el.scrollTop + el.clientHeight < el.scrollHeight - 4);
  };
  useEffect(syncFade, [visible.length, expanded, maxHeight]);

  const onSearchKeyDown = (e: RKEvent<HTMLInputElement>) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (visible.length === 0) return;
      e.preventDefault();
      e.stopPropagation();
      const n = visible.length;
      setActive(
        e.key === "ArrowDown"
          ? active < 0
            ? 0
            : (active + 1) % n
          : active <= 0
            ? n - 1
            : active - 1,
      );
      return;
    }
    if (e.key === "Enter") {
      // 没按过 ↑↓ 时 Enter 什么都不做：打到这儿敲回车，去跑「猜的第一条」是意外后果
      if (active >= 0 && visible[active]) {
        e.preventDefault();
        e.stopPropagation();
        onRun(visible[active]);
      }
      return;
    }
    // 有字时 Esc 只清空搜索；空了才让按键冒泡去关弹层（两级取消）
    if (e.key === "Escape" && query) {
      e.preventDefault();
      e.stopPropagation();
      setQuery("");
    }
  };

  const row = (a: AiActionMeta, i: number) => (
    <PopRow
      key={a.id}
      a={a}
      idx={i}
      active={i === active}
      busy={busyId === a.id}
      onClick={() => (busyId ? undefined : onRun(a))}
    />
  );

  return (
    <div
      className={`pop-layer${scrolled ? " scrolled" : ""}`}
      style={{ left, top, maxHeight }}
      role="dialog"
      aria-label="AI 处理识别文字"
    >
      <PopHead
        title="AI 处理"
        ai
        sub={`${linesSub(lines)} · 会把内容发送到所选服务商，可能计费`}
        onClose={onClose}
      />

      {res?.status === "ok" && (
        <>
          <div className="pop-result">
            <div className="meta">{res.meta}</div>
            {res.content}
          </div>
          <PopFoot copied={copied} onCopy={onCopy} onClose={onClose} />
        </>
      )}
      {res?.status === "running" && (
        <div className="pop-body">
          <div className="pop-empty">{res.message}</div>
        </div>
      )}
      {res?.status === "error" && (
        <>
          <div className="pop-result err">{res.message}</div>
          <div className="pop-foot">
            <button className="fb" onClick={onClose}>
              关闭
            </button>
          </div>
        </>
      )}
      {res?.status === "confirm" && (
        <>
          <div className="pop-confirm">
            ⚠️ {res.confirmReason}
            <br />
            <span className="hint">继续会消耗额度并调用云端。</span>
          </div>
          <div className="pop-foot">
            <button className="fb primary" onClick={onContinue}>
              继续
            </button>
            <button className="fb" onClick={onClose}>
              取消
            </button>
          </div>
        </>
      )}

      {(!res || res.status === "idle") && (
        <>
          {actions.length > 0 && (
            <PopSearch
              value={query}
              total={actions.length}
              onChange={setQuery}
              onKeyDown={onSearchKeyDown}
            />
          )}
          <div className="pop-body" ref={bodyRef} onScroll={syncFade}>
            {actions.length === 0 ? (
              <div className="pop-empty">加载动作清单中…</div>
            ) : searching && visible.length === 0 ? (
              <div className="pop-none">
                没有匹配「{query.trim()}」的动作
                <br />
                <span className="hint">Esc 清空搜索</span>
              </div>
            ) : searching ? (
              <>
                {/* 打了字就不分推荐段：要在这批里找人，再切两层只会把结果切碎 */}
                <div className="act-group">匹配 {list.matched} 项</div>
                {list.rest.map(row)}
              </>
            ) : !ctx ? (
              list.rest.map(row)
            ) : (
              <>
                {list.rec.length > 0 && (
                  <>
                    <div className="act-group">推荐 · 按这段内容排</div>
                    {list.rec.map(row)}
                  </>
                )}
                {expanded ? (
                  <>
                    <div className="act-group">全部 {list.rest.length} 项</div>
                    {/* 下标接着推荐段往后数，↑↓ 才能一路走到清单末尾 */}
                    {list.rest.map((a, i) => row(a, list.rec.length + i))}
                  </>
                ) : (
                  list.rest.length > 0 && (
                    <PopExpandRow
                      count={list.rest.length}
                      preview={list.rest
                        .slice(0, 4)
                        .map((a) => a.label)
                        .join(" / ")}
                      onClick={() => setExpanded(true)}
                    />
                  )
                )}
              </>
            )}
          </div>
          <div className="pop-fade" />
        </>
      )}
    </div>
  );
}
