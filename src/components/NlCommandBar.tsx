/**
 * NlCommandBar.tsx —— v6.3 自然语言动作（本地解析，零 AI 成本）。
 *
 * 变换中心顶部的指令输入框：一句话（「改得正式一点」「翻译成英文」「总结要点」）
 * → 本地关键词解析器（nlActionParser）映射到已有动作 + 参数 → 回调给枢纽
 * （定位卡片 + 预填参数）。
 *
 * 门控（规则 15）：命中 AI 动作但未启用时，解析器返回 aiDisabled，
 * 本组件提示先到设置启用——绝不绕过开关、绝不静默调用。
 */
import { memo, useRef, useState } from "react";
import { CornerDownLeft, Lightbulb } from "lucide-react";
import { parseNlCommand, type NlParseResult } from "@/lib/nlActionParser";
import styles from "./NlCommandBar.module.css";

export const NlCommandBar = memo(function NlCommandBar({
  onResult,
}: {
  /** 解析结果回调（命中/未命中/aiDisabled 都由枢纽处理反馈） */
  onResult: (r: NlParseResult) => void;
}) {
  const [value, setValue] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = () => {
    const r = parseNlCommand(value);
    onResult(r);
    // 命中后清空输入，方便连续尝试不同指令
    if (r.actionId) setValue("");
    else inputRef.current?.select();
  };

  return (
    <div className={styles.bar}>
      <span className={styles.icon}><Lightbulb size={13} /></span>
      <input
        ref={inputRef}
        className={styles.input}
        value={value}
        placeholder="想做什么？如：改得正式一点 / 翻译成英文 / 总结要点"
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            submit();
          }
        }}
      />
      <button className={styles.goBtn} onClick={submit} title="执行指令">
        <CornerDownLeft size={13} />
      </button>
    </div>
  );
});
