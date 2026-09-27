/**
 * 输入态底栏（快捷条设计稿 §1–§3.5）：输入行 + 常驻时间快捷条 + @解析预览条。
 * 从 TodoIslandList 拆出（规则 #7：单文件 300 行红线）。
 *
 * - **快捷条是主路径**（点，不用打）：选中项只存组件状态、不往输入文本插字符；
 *   提交时才拼回 `@日期 [时刻]` 尾巴——解析真值仍在 Rust `due_tail` 一条链上。
 * - **时刻 chip 自适应**（§3.5）：本会话打开时读一次 top3，会话内不换目标防点击漂移；
 *   创建带时刻的待办时计一次数（`recordQuickTime`）。
 * - **收口不变量**：文本 @ 尾巴与快捷条选择**不同时存在**——打 @ 清快捷条、
 *   带选择提交时先摘文本尾巴。守卫见 islandBridge.test.ts / 本组件测试。
 * - **@ 语法保留兼容**：预览条仍如实显示（含 ⚠ 态）；旧 @ 补全面板退役。
 * - **Esc 两级**：面板没了，Esc 直接走岛层既有两级取消（compose→list→pill）。
 * - **⚠ 态回车不拦**：预览职责到「如实告知」为止，拦截是把提示升级成门禁。
 */
import { useEffect, useState } from "react";
import {
  parseDuePreview,
  hasAtTail,
  atTailStarted,
  stripAtTail,
  QUICK_DATES,
  loadQuickTimes,
  recordQuickTime,
} from "@/lib/todo/islandBridge";
import type { DuePreview } from "@/lib/todo/islandBridge";
import styles from "./TodoIsland.module.css";

/** ⚠ 态文案（L 规则：说清支持什么，一句以内）。解析真值在 Rust，这里只管措辞。 */
const DUE_BAD_COPY = "@后面的时间没看懂 —— 支持 今天 / 明天 / 后天 / 9/26，可选 16:00";

/** 快捷条选中项（组件状态，不进文本）：date 恒非空当 time 非空——点时刻默认挂今天 */
interface QuickSel {
  date: string | null;
  time: string | null;
}

const NO_SEL: QuickSel = { date: null, time: null };

interface Props {
  /** 输入草稿挂岛层（受控）：自动收起要判断「有没打完的字」，收起不销毁草稿 */
  composeText: string;
  onComposeText: (s: string) => void;
  /** 提交最终文本（快捷条选择已拼成 @ 尾巴）；空文本由调用方忽略 */
  onAdd: (text: string) => void;
}

export function TodoIslandCompose({ composeText, onComposeText, onAdd }: Props) {
  const [sel, setSel] = useState<QuickSel>(NO_SEL);
  const [preview, setPreview] = useState<DuePreview | null>(null);
  // 会话内固定：打开 compose 时读一次，中途不换 chip（设计稿 §3.5 ③）
  const [times] = useState(loadQuickTimes);
  const showPreview = hasAtTail(composeText);
  const hasSel = sel.date !== null || sel.time !== null;

  // 每击键 invoke 一次预览（本地解析）；无尾巴直接清，不发命令
  useEffect(() => {
    if (!showPreview) {
      setPreview(null);
      return;
    }
    let alive = true;
    parseDuePreview(composeText)
      .then((p) => {
        if (alive) setPreview(p);
      })
      .catch(() => {
        if (alive) setPreview(null);
      });
    return () => {
      alive = false;
    };
  }, [composeText, showPreview]);

  /** 文本变化：一打 @（含裸 @）即清快捷条选择（时间来源收口为一处） */
  const handleText = (s: string) => {
    onComposeText(s);
    if (atTailStarted(s)) setSel(NO_SEL);
  };

  /** 点日期 chip：已选则整组取消（时刻没了日期就不成立）；未选则记日期（=全天） */
  const pickDate = (d: string) =>
    setSel((s) => (s.date === d ? NO_SEL : { ...s, date: d }));
  /** 点时刻 chip：没选日期默认挂今天（高频路径一步到位）；再点同款取消时刻留日期 */
  const pickTime = (t: string) =>
    setSel((s) => (s.time === t ? { ...s, time: null } : { date: s.date ?? "今天", time: t }));

  /** 回车/提交：带选择时摘文本尾巴、拼 @ 尾巴、计数、复位——连续记多条不串味 */
  const submit = () => {
    const body = (hasSel ? stripAtTail(composeText) : composeText).trim();
    if (!body) return;
    if (hasSel && sel.date !== null) {
      if (sel.time) recordQuickTime(sel.time);
      onAdd(`${body} @${sel.date}${sel.time ? ` ${sel.time}` : ""}`);
      setSel(NO_SEL);
    } else {
      onAdd(body);
    }
  };

  return (
    <>
      <div className={styles.foot}>
        <input
          className={styles.cinput}
          value={composeText}
          placeholder="要做什么？"
          aria-label="记一条待办"
          autoFocus
          onChange={(e) => handleText(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") submit();
          }}
        />
        {hasSel ? (
          <span className={styles.duetag}>
            {sel.date}
            {sel.time ? ` ${sel.time}` : ""}
            <button type="button" className={styles.duetagX} onClick={() => setSel(NO_SEL)} aria-label="移除已选时间">
              ✕
            </button>
          </span>
        ) : null}
        <span className={styles.footHint}>回车记下</span>
      </div>
      {preview !== null ? (
        <div className={`${styles.prow} ${preview.ok ? styles.prowGood : styles.prowBad}`} role="status">
          {preview.ok ? (
            <>
              <span className={styles.prowMark}>✓</span>
              <span>
                {preview.hasTime ? `${preview.label} 到点提醒` : `${preview.label}（全天，不提醒）`}
              </span>
            </>
          ) : (
            <>
              <span className={styles.prowMark}>⚠</span>
              <span>{DUE_BAD_COPY}</span>
              <button type="button" className={styles.pbtn} onClick={() => onComposeText(stripAtTail(composeText))}>
                删 @尾巴
              </button>
            </>
          )}
        </div>
      ) : null}
      <div className={`${styles.qbar} ${hasSel ? styles.qbarOn : ""}`} role="group" aria-label="快捷时间">
        <span className={styles.qlab}>时间</span>
        {QUICK_DATES.map((d) => (
          <button
            key={d}
            type="button"
            className={`${styles.qchip} ${sel.date === d ? styles.qchipOn : ""}`}
            aria-pressed={sel.date === d}
            onClick={() => pickDate(d)}
          >
            {d}
          </button>
        ))}
        <span className={styles.qsep} aria-hidden="true" />
        {times.map((t) => (
          <button
            key={t}
            type="button"
            className={`${styles.qchip} ${styles.qchipTime} ${sel.time === t ? styles.qchipOn : ""}`}
            aria-pressed={sel.time === t}
            onClick={() => pickTime(t)}
          >
            {t}
          </button>
        ))}
        <button type="button" className={styles.qclear} onClick={() => setSel(NO_SEL)} tabIndex={hasSel ? 0 : -1}>
          清除
        </button>
      </div>
    </>
  );
}
