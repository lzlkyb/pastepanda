import { TopBar } from '../../src/components/TopBar';
import { Card } from '../../src/components/Card';
import { ToolboxView } from '../../src/components/ToolboxView';
import { KnowledgeToolbar } from '../../src/components/notes/KnowledgeToolbar';
import { NoteList } from '../../src/components/notes/NoteList';
import { useAppStore, type HistoryItem } from '../../src/stores/appStore';
import { TOOLBOX_GROUPS, type ToolHandlers } from '../../src/lib/toolbox';
import type { Note } from '../../src/lib/api/notes';
import app from '../../src/App.module.css';
import cards from '../../src/components/CardList.module.css';
import knowledge from '../../src/components/KnowledgeView.module.css';
import fixture from './fixture.json';

const noop = () => {};
const handlers = Object.fromEntries(TOOLBOX_GROUPS.flatMap(group =>
  group.items.map(tool => [tool.key, noop]))) as ToolHandlers;
const notes: Note[] = fixture.map(item => ({
  id: item.id, history_id: item.id, title: item.text.split('：')[0], content: item.text,
  created_at: item.time, updated_at: item.time, source_agent: '', folder_id: null,
  summary: null, daily_date: null, tags: [],
}));

/** Source components only; native operations are deliberately absent in this storyboard. */
export function ProductSurface() {
  const mode = useAppStore(state => state.appMode);
  const keyword = useAppStore(state => state.searchKeyword);
  const visible = fixture.filter(item => !keyword || item.text.includes(keyword));
  return <div className={`${app.appShell} previewShell`}>
    <TopBar />
    <div className={app.contentArea}>
      {mode === 'tools' ? <ToolboxView handlers={handlers} /> :
        mode === 'knowledge' ? <div className={knowledge.shell}><div className={knowledge.wrap}>
          <KnowledgeToolbar folderName="全部笔记" total={notes.length} keyword="" onKeyword={noop}
            onNew={noop} newHint="新建笔记" qaEnabled={false} mode="search" onMode={noop}
            question="" onQuestion={noop} onAsk={noop} />
          <div className={knowledge.listWrap}>
            <NoteList notes={notes} folders={[]} activeId={null} showFolderColumn={false}
              groupCounts={new Map()} hasMore={false} loadingMore={false} onLoadMore={noop}
              keyword="" onTagClick={noop} selectedIds={new Set()} onRowSelect={noop}
              onClearSelection={noop} onOpen={noop} onDelete={noop} onTogglePin={noop}
              buildMenu={() => []} folderMenu={() => []} layout="list" cols={1} />
          </div>
        </div></div> : <div className={app.cardPanel}>
          <div className={`${cards.cardList} sourceRows`} role="listbox" aria-label="剪贴板历史">
            {visible.map((item, index) => <Card key={item.id} item={item as HistoryItem} index={index}
              selected={false} searchKeyword={keyword} disablePreview onClick={noop} onDoubleClick={noop} />)}
          </div>
        </div>}
    </div>
  </div>;
}
