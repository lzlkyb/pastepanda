/**
 * useAiActionEditor —— 自定义动作编辑器的状态与动作（从 `AiActionEditor.tsx` 抽出，规则 #7）。
 *
 * 拆法刻意选「抽逻辑、留 JSX」而不是「切两块子组件」：这个编辑器的状态彼此牵连
 * （改模板要让旧试跑结果作废、套示例要同时清掉错误与结果、试跑要管敏感内容确认），
 * 切成子组件就得把这些联动写成跨组件的 props 往返——那才是真的容易写错。
 * 状态全在这里、顺序全在这里，行为与拆出来之前逐字一致。
 *
 * 校验全部交给后端（`validate_template` / 重名检查），这里只负责把错误摆出来：
 * 前后端各写一份校验规则，迟早会漂。
 */
import { useRef, useState } from "react";
import {
  aiPreviewCustom,
  aiSaveCustomAction,
  type AiCustomAction,
} from "@/lib/api";
import { type ActionTemplate } from "./actionTemplates";
import { budgetExceededMessage } from "@/lib/aiBudgetMsg";
import { insertAtCursor } from "@/lib/insertAtCursor";

export const PLACEHOLDER = "{{内容}}";

const EMPTY: AiCustomAction = {
  id: "",
  name: "",
  description: "",
  icon: "sparkles",
  template: "",
  maxTokens: 1024,
  contentTypes: [],
  enabled: true,
  sortOrder: 0,
  createdAt: "",
  updatedAt: "",
};

export interface AiActionOutput {
  ok: boolean;
  text: string;
  /** 回答撞到 token 上限被截断——这是“模板写得不好”之外的另一回事，要分开说 */
  truncated?: boolean;
}

export function useAiActionEditor(action: AiCustomAction | null, onSaved: () => void) {
  const [draft, setDraft] = useState<AiCustomAction>(action ?? EMPTY);
  const [error, setError] = useState("");
  const [saving, setSaving] = useState(false);
  const [sample, setSample] = useState("");
  const [testing, setTesting] = useState(false);
  const [output, setOutput] = useState<AiActionOutput | null>(null);
  const templateRef = useRef<HTMLTextAreaElement>(null);
  /** v6.4 审查修复：#1 敏感试跑确认 —— needsConfirm 后按钮改「确认发送」并传 force=true */
  const [confirming, setConfirming] = useState(false);
  /** v6.4 审查修复：#3 模板/样例变化后旧结果作废 */
  const [dirtySinceRun, setDirtySinceRun] = useState(false);
  /** v6.4 审查修复：#2 删除二次确认 */
  const [confirmDelete, setConfirmDelete] = useState(false);

  const isNew = !action;
  const patch = (p: Partial<AiCustomAction>) => {
    if (p.template !== undefined && p.template !== draft.template) setDirtySinceRun(true);
    setDraft((d) => ({ ...d, ...p }));
  };
  const changeSample = (v: string) => {
    setSample(v);
    if (output) setDirtySinceRun(true);
  };

  const applyTemplate = (t: ActionTemplate) => {
    setDraft({
      ...EMPTY,
      name: t.name,
      description: t.description,
      icon: t.icon,
      template: t.template,
      maxTokens: t.maxTokens,
      contentTypes: t.contentTypes,
    });
    setSample(t.sample);
    setError("");
    setOutput(null);
  };

  /** 把占位符插到光标处——比让用户背语法强。
   *  光标计算收口到 @/lib/insertAtCursor（转笔记模板的变量按钮是第二个调用点） */
  const insertPlaceholder = () => {
    patch({ template: insertAtCursor(templateRef.current, draft.template, PLACEHOLDER) });
  };

  const toggleType = (id: string) => {
    const has = draft.contentTypes.includes(id);
    patch({
      contentTypes: has
        ? draft.contentTypes.filter((x) => x !== id)
        : [...draft.contentTypes, id],
    });
  };

  const save = async () => {
    setSaving(true);
    setError("");
    try {
      await aiSaveCustomAction(draft);
      onSaved();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  const tryRun = async (force = false) => {
    setTesting(true);
    setConfirming(false); // 结果决定最终状态：needsConfirm 会重新置 true
    setDirtySinceRun(false);
    setOutput(null);
    try {
      const r = await aiPreviewCustom(draft.template, sample, draft.maxTokens, force);
      switch (r.status) {
        case "ok":
          setOutput({ ok: true, text: r.content, truncated: r.truncated });
          break;
        case "needsConfirm":
          setConfirming(true);
          setOutput({ ok: false, text: `${r.reason}（再点一次确认发送）` });
          break;
        case "budgetExceeded":
          setOutput({
            ok: false,
            text: budgetExceededMessage(r.spentCny, r.budgetCny),
          });
          break;
      }
    } catch (e) {
      setOutput({ ok: false, text: e instanceof Error ? e.message : String(e) });
    } finally {
      setTesting(false);
    }
  };

  const canTest = !testing && !!draft.template.trim() && !!sample.trim();

  return {
    isNew,
    draft,
    error,
    saving,
    sample,
    testing,
    output,
    confirming,
    dirtySinceRun,
    confirmDelete,
    setConfirmDelete,
    templateRef,
    patch,
    changeSample,
    applyTemplate,
    insertPlaceholder,
    toggleType,
    save,
    tryRun,
    canTest,
  };
}
