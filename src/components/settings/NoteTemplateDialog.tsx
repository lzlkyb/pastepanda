/**
 * 「编辑默认模板」弹窗（B2 #8）。壳子与类型定制弹窗共用，这里只管草稿状态。
 *
 * 取消 / 保存语义：弹窗里敲的是**草稿**，不点保存就不落库。
 * （之前常显面板那版是失焦即存，改成弹窗后那套就不适用了：
 *  弹窗本身就是一个明确的「我要改这个」手势，它理当有取消。）
 */
import { useEffect, useState } from "react";
import { NoteTemplateDialogShell } from "./NoteTemplateDialogShell";
import { NoteTemplateEditor } from "./NoteTemplateEditor";

interface Props {
  open: boolean;
  initial: string;
  /** 只用于提醒「预览用的这条卡片其实走类型定制」 */
  overrides: Record<string, string>;
  onClose: () => void;
  onSave: (tpl: string) => void;
}

export function NoteTemplateDialog({ open, initial, overrides, onClose, onSave }: Props) {
  const [draft, setDraft] = useState(initial);

  // 每次打开重新从配置取：上次取消掉的草稿不能留到下一次
  useEffect(() => {
    if (open) setDraft(initial);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open]);

  return (
    <NoteTemplateDialogShell
      open={open}
      title="编辑默认模板"
      dirty={draft !== initial}
      onClose={onClose}
      onSave={() => onSave(draft)}
    >
      <NoteTemplateEditor value={draft} onChange={setDraft} overrides={overrides} />
    </NoteTemplateDialogShell>
  );
}
