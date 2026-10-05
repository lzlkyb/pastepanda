/**
 * NlCommandBar.tsx —— v6.3 自然语言动作（本地解析，零 AI 成本）。
 *
 * 变换中心顶部的指令输入框：一句话（「改得正式一点」「翻译成英文」「总结要点」）
 * → 本地关键词解析器（nlActionParser）映射到已有动作 + 参数 → 回调给枢纽
 * （定位卡片 + 预填参数）。
 *
 * 门控（规则 15）：命中 AI 动作但未启用时，解析器返回 aiDisabled，
 * 本组件提示先到设置启用——绝不绕过开关、绝不静默调用。
 *
 * 外壳走共用的 `Composer`（提案 2 单行紧凑）：静息是淡光晕，聚焦才亮起来。
 */
import { memo, useRef, useState } from "react";
import { CornerDownLeft, Lightbulb } from "lucide-react";
import { parseNlCommand, type NlParseResult } from "@/lib/nlActionParser";
import { Composer, type ComposerHandle } from "@/components/Composer";
import styles from "./NlCommandBar.module.css";

export const NlCommandBar = memo(function NlCommandBar({
  onResult,
}: {
  /** 解析结果回调（命中/未命中/aiDisabled 都由枢纽处理反馈） */
  onResult: (r: NlParseResult) => void;
}) {
  const [value, setValue] = useState("");
  const composerRef = useRef<ComposerHandle>(null);

  const submit = () => {
    const r = parseNlCommand(value);
    onResult(r);
    // 命中后清空输入，方便连续尝试不同指令
    if (r.actionId) setValue("");
    // 未命中就把原文选中：用户要的是改两个词，不是从头再打一遍
    else composerRef.current?.select();
  };

  return (
    <Composer
      ref={composerRef}
      className={styles.nlComposer}
      variant="slim"
      value={value}
      onChange={setValue}
      onSubmit={submit}
      /* ❗ 不给空值禁用发送钮：空着点 ⏎ 也要走解析器，那边才有「没看懂」的反馈。
         禁用它就是把一个动作变成「点了没反应」（规则 15.3）。 */
      placeholder="想做什么？如：改得正式一点 / 翻译成英文 / 总结要点"
      ariaLabel="自然语言指令"
      lead={
        <span className={styles.icon}>
          <Lightbulb size={13} />
        </span>
      }
      send={<CornerDownLeft size={13} />}
      sendLabel="执行指令"
      sendTitle="执行指令（Enter）"
    />
  );
});
