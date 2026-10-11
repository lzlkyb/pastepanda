import { useState } from "react";
import { createRoot } from "react-dom/client";
import { KnowledgeView } from "../src-mobile/knowledge/KnowledgeView";
import { MobileSheet } from "../src-mobile/ui/MobileSheet";
import { MobileScene } from "../src-mobile/ui/MobileScene";
import { MOBILE_DESTINATIONS, type MobileDestination } from "../src-mobile/ui/mobileDestinations";
import { useMobileNavigation } from "../src-mobile/ui/useMobileNavigation";
import { useMobilePager } from "../src-mobile/ui/useMobilePager";
import { useMobileViewport } from "../src-mobile/ui/useMobileViewport";
import type { MobileKnowledgeDraft } from "../src/lib/api/mobileKnowledge";
import type { MobileKnowledgeEditDraft } from "../src/lib/api/mobileKnowledgeEdit";
import type { Note } from "../src/lib/api/notes";
import app from "../src-mobile/App.module.css";
import ui from "../src-mobile/ui/MobileUi.module.css";
import "../src/styles/theme.css";
import "../src-mobile/styles/mobile-base.css";
import "./mobile-controlled-pager-demo-2026-10-11.css";

const note: Note = { id: "demo-note", title: "让工具退后一步", content: "## 完成眼前的一件事\n\n我们打开手机，是为了读一篇文章，查看一份资料，或远程操作电脑。\n\n" + "界面留出空间，让内容成为主角。常用的动作随时可达，操作结果也清楚可见。\n\n".repeat(16), tags: [], folder_id: null, created_at: "2026-10-11T09:00:00Z", updated_at: "2026-10-11T09:00:00Z", history_id: null, source_agent: "", summary: null, daily_date: null };
let draft: MobileKnowledgeDraft | null = null, edit: MobileKnowledgeEditDraft | null = null;
const metadata = { common: false, reading_position: 0, last_access_at: null };
// This isolated iframe has its own simulated backend; no real device/storage API is called.
Object.assign(window, { __TAURI_INTERNALS__: { invoke: async (command: string, args: Record<string, unknown> = {}) => {
  switch (command) {
    case "mobile_knowledge_list": return { items: [{ ...note, excerpt: "界面留出空间，让内容成为主角。", ...metadata }], has_more: false };
    case "note_get": return note;
    case "mobile_knowledge_meta": case "mobile_knowledge_visit": return metadata;
    case "mobile_knowledge_set_common": metadata.common = !!args.common; return metadata;
    case "mobile_knowledge_draft_get": return draft;
    case "mobile_knowledge_draft_put": draft = args.draft as MobileKnowledgeDraft; return draft;
    case "mobile_knowledge_draft_clear": draft = null; return null;
    case "mobile_knowledge_edit_get": return edit;
    case "mobile_knowledge_edit_begin": edit = { id: "demo-edit", revision: 1, note_id: note.id, base_version: "base", base_note: note, title: note.title, content: note.content, folder_id: null, tag_ids: [], updated_at: "" }; return edit;
    case "mobile_knowledge_edit_put": edit = args.draft as MobileKnowledgeEditDraft; return edit;
    case "mobile_knowledge_edit_clear": edit = null; return null;
    case "mobile_knowledge_draft_commit": case "mobile_knowledge_edit_commit": throw new Error("演示仅保留内存草稿，不保存真实笔记。");
    case "get_kb_sync_status": return false;
    case "kb_sync_devices": return { devices: [], last: [], conflict_backlog: 0 };
    case "rc_sync_offers": case "rc_sync_devices": case "mobile_article_pending": case "folder_list": case "get_tags": return [];
    case "plugin:event|listen": return 1;
    default: return null;
  }
} } });
const ids = MOBILE_DESTINATIONS.map(item => item.id);
function Preview() {
  useMobileViewport();
  const [focused, setFocused] = useState(false), [sheet, setSheet] = useState(false);
  const { tab, selectTab } = useMobileNavigation<MobileDestination>(ids, "devices", true);
  const task = tab === "knowledge" && focused;
  const pager = useMobilePager(ids, tab, selectTab, !task);
  return <div className={app.root} data-focused={task}>
    <main className={app.pane}><div ref={pager.contentRef} className={app.tabContent} data-pager-enabled={!task} {...pager.events}>
      {MOBILE_DESTINATIONS.map(({ id, label }) => <MobileScene key={id} label={label} active={tab === id} paged interactive={tab === id && !pager.moving} className={`${app.pagePane} ${id === "knowledge" ? app.knowledgePane : ""}`}>
        {id === "knowledge" ? <KnowledgeView active={tab === id} onTaskChange={setFocused} /> : <div className={ui.page}>
          <header className={ui.pageHead}><div className={ui.pageHeadCopy}><h1>{label}</h1><p className={ui.subtitle}>示例内容 · 验证导航与手势</p></div><button className={ui.textButton} onClick={() => setSheet(true)}>筛选</button></header>
          {id === "devices" && <><section className="demoCard"><strong>我的电脑</strong><p>已配对设备保留在此。</p><button className={ui.secondary} onClick={() => pager.navigate("files")}>查看文件示例</button></section><p className={ui.description}>普通内容区左右滑动，切换主页面。系统边缘留给返回。</p></>}
          {id === "files" && <><label className="demoField">搜索文件<input placeholder="输入框不切 Tab" /></label><div className="demoHorizontal" aria-label="局部横向内容"><div>最近接收</div><div>工作资料</div><div>图片备份</div><div>本机文件</div></div></>}
          {id === "settings" && <section className="demoCard"><strong>操作习惯</strong><p>横滑与底部点击同时保留。</p><label className="demoField">测试输入<input placeholder="切走再回来，输入仍保留" /></label></section>}
          {Array.from({ length: 8 }, (_, index) => <section className="demoCard" key={index}><strong>{label}示例 {index + 1}</strong><p>上下滚动保留位置，横向分页交给浏览器吸附。</p></section>)}
        </div>}
      </MobileScene>)}
    </div></main>
    <nav className={app.tabbar} hidden={task} aria-label="主要导航">{MOBILE_DESTINATIONS.map(({ id, label, Icon }) => <button key={id} className={`${app.tab} ${tab === id ? app.tabActive : ""}`} aria-current={tab === id ? "page" : undefined} onClick={() => pager.navigate(id)}><Icon size={23} aria-hidden="true" /><span>{label}</span></button>)}</nav>
    <MobileSheet open={sheet} title="筛选示例" onClose={() => setSheet(false)} actions={<button className={ui.primary} onClick={() => setSheet(false)}>应用并关闭</button>}><p className={ui.description}>拖动页头或把手。短拖回弹；正文继续上下滚动。</p>{Array.from({ length: 8 }, (_, index) => <button key={index} className={ui.secondary}>文件夹示例 {index + 1}</button>)}</MobileSheet>
  </div>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
