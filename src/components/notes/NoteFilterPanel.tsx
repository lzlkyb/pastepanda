/**
 * NoteFilterPanel — 筛选浮层里的那几行（A-60 从 KnowledgeView 拆出）。
 *
 * 纯展示：收五个 prop，吐五行控件。自己不拿 state、不调 API。
 *
 * ❗ 行序不是随便摆的：**标签在最上面**——它是这几个维度里唯一一个
 *   「用户自己建的」，也是最常用的那个。
 */
import { TriRow, TagPickRow, PickRow } from "@/components/notes/ViewControls";
import { NOTE_WITHINS, type NoteViewOpts } from "@/lib/notes/viewOpts";
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
