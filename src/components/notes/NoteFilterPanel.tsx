/**
 * NoteFilterPanel — 筛选浮层里的那几行（A-60 从 KnowledgeView 拆出）。
 *
 * 纯展示：收五个 prop，吐五行控件。自己不拿 state、不调 API。
 *
 * ❗ 行序不是随便摆的：**标签在最上面**——它是这几个维度里唯一一个
 *   「用户自己建的」，也是最常用的那个。
 */
import { TriRow, TagPickRow, PickRow } from "@/components/notes/ViewControls";
import { NOTE_AUTHORS, NOTE_WITHINS, type NoteViewOpts } from "@/lib/notes/viewOpts";
import type { Tag } from "@/stores/appStore";

export interface NoteFilterPanelProps {
  view: NoteViewOpts;
  onPatch: (patch: Partial<NoteViewOpts>) => void;
  allTags: Tag[];
  tagIds: string[];
  onToggleTag: (id: string) => void;
}

export function NoteFilterPanel({
  view,
  onPatch,
  allTags,
  tagIds,
  onToggleTag,
}: NoteFilterPanelProps) {
  return (
    <>
      <TagPickRow allTags={allTags} selected={tagIds} onToggle={onToggleTag} />
      <TriRow
        label="摘要"
        value={view.summary}
        yesText="有摘要"
        noText="无摘要"
        onChange={(v) => onPatch({ summary: v })}
      />
      <TriRow
        label="来源"
        value={view.fromCard}
        yesText="来自卡片"
        noText="手工新建"
        onChange={(v) => onPatch({ fromCard: v })}
      />
      <TriRow
        label="标签"
        value={view.tagged}
        yesText="有标签"
        noText="无标签"
        onChange={(v) => onPatch({ tagged: v })}
      />
      {/* §7.2：谁写的。放在「修改时间」之前——它是「这条是什么」类的属性，
          跟上面三行同族；时间是另一类，留在最后。

          🔴 用 PickRow 而不是 TriRow：这个维度是**四态**。“改过我的”
          （我建的、正文被 AI 改过）是用户唯一看不见的那一类——
          「AI 建了一篇」列表里有图标，而「AI 改了我写的」没有任何痕迹。
          塑成三态就只能在“AI 写过”里把它混进去，那个区分就没了。 */}
      <PickRow
        label="谁写的"
        options={NOTE_AUTHORS}
        value={view.author}
        onChange={(v) => onPatch({ author: v as NoteViewOpts["author"] })}
      />
      {/* B4：筛的是 **updated_at**——「最近改过什么」比「最近建了什么」
          常用得多，而且跟默认排序（最近修改）是同一个字段。 */}
      <PickRow
        label="修改时间"
        options={NOTE_WITHINS}
        value={view.updatedWithin}
        onChange={(v) => onPatch({ updatedWithin: v as NoteViewOpts["updatedWithin"] })}
      />
    </>
  );
}
