import type { ReactNode } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import type { Note } from "@/lib/api/notes";
import type { MobileKnowledgeDraft } from "@/lib/api/mobileKnowledge";
import type { MobileKnowledgeEditDraft } from "@/lib/api/mobileKnowledgeEdit";
import type { MobileKnowledgeIncoming } from "@/lib/api/mobileKnowledgeShare";
import type { useKnowledgeInbox } from "./useKnowledgeInbox";
import { KnowledgeView } from "./KnowledgeView";

vi.mock("@tauri-apps/api/core", () => ({ invoke: vi.fn() }));
vi.mock("../ui/useMobileBack", () => ({ useMobileBack: vi.fn() }));
vi.mock("../ui/MobileSheet", () => ({ MobileSheet: ({ open, title, children, footer, actions, onClose }: { open: boolean; title: string; children: ReactNode; footer: ReactNode; actions: ReactNode; onClose: () => void }) => open ? <aside role="dialog" aria-label={title}><button onClick={onClose}>关闭面板</button>{children}{footer}{actions}</aside> : null }));
const original: Note = { id: "note", title: "原笔记", content: "原来的内容", created_at: "2026-10-07T10:00:00Z", updated_at: "2026-10-07T10:00:00Z", folder_id: null, tags: [], history_id: null, source_agent: "", summary: null, daily_date: null };
const metadata = { common: false, last_access_at: null, reading_position: 0 };
const captureId = "a52cbf8d-9608-4c5a-ad76-f4760504cb21";
const incoming: MobileKnowledgeIncoming = { id: "bd924828-87cd-4f9f-9487-26b39f0c8132", title: "系统分享", text: "需要保留的文字", images: [], status: "ready", message: "", created_at: 10 };
const image: MobileKnowledgeIncoming = { ...incoming, id: "446ae64c-b85e-4461-bdfc-b19f8e61d5b0", title: "", text: "选图备注", images: ["pp-asset:0123456789abcdef0123456789abcdef.png"] };
let notes: Note[];
let draft: MobileKnowledgeDraft | null;
let edit: MobileKnowledgeEditDraft | null;
const inbox = (items: MobileKnowledgeIncoming[] = []): ReturnType<typeof useKnowledgeInbox> => ({
  items, processing: false, notice: "", error: "", ready: true, loading: false, busy: false, picking: false, pickedId: null,
  refresh: vi.fn(async () => true), acknowledge: vi.fn(async () => true), pickImages: vi.fn(async () => false),
});
beforeEach(() => {
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({ x: 0, y: 0, top: 0, left: 0, right: 390, bottom: 844, width: 390, height: 844, toJSON: () => ({}) });
  vi.spyOn(HTMLElement.prototype, "offsetHeight", "get").mockReturnValue(844);
  vi.spyOn(HTMLElement.prototype, "offsetWidth", "get").mockReturnValue(390);
  notes = [{ ...original }]; draft = null; edit = null;
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(async (command, input) => {
    const args = input as { id: string; noteId: string; draft: MobileKnowledgeDraft & MobileKnowledgeEditDraft };
    switch (command) {
      case "mobile_knowledge_list": return { items: notes.map(n => ({ ...n, excerpt: n.content, folder_name: null, ...metadata })), has_more: false };
      case "mobile_article_pending": return [];
      case "mobile_article_for_note": return null;
      case "note_get": return notes.find(n => n.id === args.id) || null;
      case "mobile_knowledge_meta": case "mobile_knowledge_visit": return metadata;
      case "mobile_knowledge_draft_get": return draft;
      case "mobile_knowledge_draft_put": draft = args.draft; return draft;
      case "mobile_knowledge_draft_commit": { const n = { ...original, id: draft!.id, title: draft!.title, content: draft!.content }; notes.push(n); draft = null; return n; }
      case "mobile_knowledge_edit_get": return edit;
      case "mobile_knowledge_edit_begin": { const n = notes.find(n => n.id === args.noteId)!; edit = { id: "edit", revision: 1, note_id: n.id, base_version: "base", base_note: n, title: n.title, content: n.content, folder_id: null, tag_ids: [], updated_at: "" }; return edit; }
      case "mobile_knowledge_edit_put": edit = args.draft; return edit;
      case "mobile_knowledge_edit_commit": { const n = { ...notes[0], title: edit!.title, content: edit!.content, updated_at: "2026-10-08T09:00:00Z" }; notes[0] = n; edit = null; return { status: "saved", note: n, relinked: 0 }; }
      case "get_kb_sync_status": return false;
      case "kb_sync_devices": return { devices: [], last: [], conflict_backlog: 0 };
      case "rc_sync_offers": case "folder_list": case "get_tags": return [];
      case "mobile_knowledge_image": throw new Error("image unavailable in UI fixture");
      default: return undefined;
    }
  });
});
afterEach(() => { cleanup(); vi.restoreAllMocks(); });
it("reopening an unconsumed article share uses article preview again",async()=>{
  const source=inbox([{...incoming,text:"https://example.com/article"}]);
  const baseline=vi.mocked(invoke).getMockImplementation()!;
  const task={id:"article",revision:1,url:source.items[0].text,title:"文章标题",author:"",html:"",body:"已取得的正文",remarks:"",folder_id:null,tag_ids:[],images:[],source_ids:[incoming.id],error:"",note_id:null,duplicate_note_id:null,saved_link_only:false,baseline_title:"",baseline_content:""};
  vi.mocked(invoke).mockImplementation(async(command,args)=>{
    if(command==="mobile_article_begin" || command==="mobile_article_get")return task;
    if(command==="mobile_article_pending")return [task];
    return baseline(command,args);
  });
  render(<KnowledgeView active inbox={source}/>);
  await screen.findByRole("region",{name:"收藏文章"});
  fireEvent.click(screen.getByRole("button",{name:"返回"}));
  fireEvent.click(await screen.findByRole("button", { name: /待处理/ }));
  fireEvent.click(await screen.findByRole("button",{name:/文章标题/}));
  await screen.findByRole("region",{name:"收藏文章"});
  expect(screen.queryByRole("dialog",{name:"收集内容预览"})).toBeNull();
  expect(source.acknowledge).not.toHaveBeenCalled();
});

it("quick saving a share opens the saved note; failed queue cleanup cannot create a duplicate", async () => {
  const source = inbox([incoming]);
  source.acknowledge = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  render(<KnowledgeView active inbox={source} />);
  fireEvent.click(await screen.findByRole("button", { name: "保存到手机" }));
  await screen.findByText("笔记已保存到手机");
  expect(notes.filter(note => note.id === incoming.id)).toHaveLength(1);
  fireEvent.click(screen.getByRole("button", { name: "重试清理收集状态" }));
  await waitFor(() => expect(source.acknowledge).toHaveBeenCalledTimes(2));
  expect(notes.filter(note => note.id === incoming.id)).toHaveLength(1);
  await within(screen.getByRole("region", { name: "笔记全文" })).findByText(incoming.text);
});

it("a lost quick-save reply recovered in the editor never saves a later unrelated draft", async () => {
  const source = inbox([incoming]);
  const originalInvoke = vi.mocked(invoke).getMockImplementation()!;
  let lost = true;
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command === "mobile_knowledge_draft_commit") {
      const saved = notes.find(note => note.id === (args as { id: string }).id);
      if (saved) return saved;
      const result = await originalInvoke(command, args);
      if (lost) { lost = false; throw new Error("reply lost"); }
      return result;
    }
    return originalInvoke(command, args);
  });
  render(<KnowledgeView active inbox={source} />);
  fireEvent.click(await screen.findByRole("button", { name: "保存到手机" }));
  await within(screen.getByRole("dialog", { name: "收集内容预览" })).findByRole("alert");
  fireEvent.click(screen.getByRole("button", { name: "关闭面板" }));
  fireEvent.click(screen.getByRole("button", { name: "重试保存到手机" }));
  await screen.findByText("已保存到手机");
  fireEvent.click(screen.getByRole("button", { name: /^返回$/ }));
  fireEvent.click(screen.getByRole("button", { name: "新建" }));
  fireEvent.click(screen.getByRole("button", { name: "写笔记" }));
  fireEvent.change(await screen.findByLabelText("内容", { exact: true }), { target: { value: "草稿B，不应由分享A保存" } });
  fireEvent.click(screen.getByRole("button", { name: "查看收集内容" }));
  fireEvent.click(screen.getByRole("button", { name: "重试清理收集状态" }));
  await waitFor(() => expect(source.acknowledge).toHaveBeenCalledWith(incoming.id));
  expect(notes).toHaveLength(2);
  expect((screen.getByLabelText("内容", { exact: true }) as HTMLTextAreaElement).value).toBe("草稿B，不应由分享A保存");
  expect(vi.mocked(invoke).mock.calls.filter(([command]) => command === "mobile_knowledge_draft_commit").map(([,args]) => (args as {id:string}).id)).toEqual([incoming.id, incoming.id]);
});

it("saved edits immediately show the new body instead of stale text under a success receipt", async () => {
  render(<KnowledgeView active />);
  fireEvent.click(await screen.findByRole("button", { name: /原笔记 原来的内容/ }));
  await screen.findByRole("heading", { name: "原笔记" });
  fireEvent.click(screen.getByRole("button", { name: "更多" }));
  fireEvent.click(screen.getByRole("button", { name: "修改笔记" }));
  await screen.findByRole("heading", { name: "修改笔记" });
  fireEvent.change(screen.getByLabelText("内容", { exact: true }), { target: { value: "手机保存后的新正文" } });
  fireEvent.click(screen.getByRole("button", { name: "保存修改到手机" }));
  await screen.findByText("修改已保存到手机");
  await within(screen.getByRole("region", { name: "笔记全文" })).findByText("手机保存后的新正文");
  expect(screen.queryByText("原来的内容", { selector: "article p" })).toBeNull();
  expect(screen.queryByText("本机正文已更新")).toBeNull();
});

it("a warm share remains reachable while writing and cannot replace the existing capture", async () => {
  draft = { id: captureId, revision: 1, title: "已有记录", content: "正在写的内容" };
  const source = inbox();
  const page = render(<KnowledgeView active inbox={source} />);
  fireEvent.click(await screen.findByRole("button", { name: /待处理/ }));
  fireEvent.click(await screen.findByRole("button", { name: /^继续写/ }));
  page.rerender(<KnowledgeView active inbox={{ ...source, items: [incoming] }} />);
  fireEvent.click(screen.getByRole("button", { name: "查看收集内容" }));
  await screen.findByText("先处理正在写的记录");
  expect((screen.getByRole("button", { name: "继续编辑" }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "继续已有草稿" }));
  expect((screen.getByLabelText("内容", { exact: true }) as HTMLTextAreaElement).value).toBe("正在写的内容");
  expect(source.acknowledge).not.toHaveBeenCalled();
});

it("picker binds its returned payload; failed acknowledgement never appends the contents twice", async () => {
  draft = { id: captureId, revision: 1, title: "已有记录", content: "原输入" };
  let resolve!: (value: boolean) => void;
  const source = inbox(); source.pickImages = vi.fn(() => new Promise<boolean>(done => { resolve = done; }));
  source.acknowledge = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  const page = render(<KnowledgeView active inbox={source} />);
  fireEvent.click(await screen.findByRole("button", { name: /待处理/ }));
  fireEvent.click(await screen.findByRole("button", { name: /^继续写/ }));
  fireEvent.click(screen.getByRole("button", { name: "添加图片" }));
  page.rerender(<KnowledgeView active inbox={{ ...source, items: [incoming] }} />);
  expect(screen.queryByRole("dialog", { name: "收集内容预览" })).toBeNull();
  page.rerender(<KnowledgeView active inbox={{ ...source, items: [incoming, image], pickedId: image.id }} />);
  await act(async () => resolve(true));
  await screen.findByRole("button", { name: "重试清理收集状态" });
  fireEvent.click(screen.getByRole("button", { name: "重试清理收集状态" }));
  await waitFor(() => expect(source.acknowledge).toHaveBeenCalledTimes(2));
  expect(draft!.content.split("选图备注")).toHaveLength(2);
  expect(draft!.content.split(image.images[0])).toHaveLength(2);
  expect(draft!.content).not.toContain(incoming.text);
});

it("acknowledgement can be retried after the imported capture has become a saved note", async () => {
  const source = inbox([incoming]); source.acknowledge = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  render(<KnowledgeView active inbox={source} />);
  await waitFor(() => expect((screen.getByLabelText("文字与备注") as HTMLTextAreaElement).value).toBe(incoming.text));
  fireEvent.click(await screen.findByRole("button", { name: "继续编辑" }));
  await screen.findByRole("button", { name: "重试清理收集状态" });
  fireEvent.click(within(screen.getByRole("dialog", { name: "收集内容预览" })).getByRole("button", { name: "关闭面板" }));
  fireEvent.click(screen.getByRole("button", { name: "保存到手机" }));
  await screen.findByText("已保存到手机");
  fireEvent.click(screen.getByRole("button", { name: "返回" }));
  fireEvent.click(await screen.findByRole("button", { name: /待处理/ }));
  fireEvent.click(await screen.findByRole("button", { name: /^查看收集内容/ }));
  fireEvent.click(screen.getByRole("button", { name: "重试清理收集状态" }));
  await waitFor(() => expect(source.acknowledge).toHaveBeenCalledTimes(2));
  expect(notes.filter(n => n.id === incoming.id)).toHaveLength(1);
  expect(screen.getByRole("heading", { name: "知识库" })).toBeTruthy();
});

it("从待处理继续草稿后返回，保留列表原滚动位置", async () => {
  draft = { id: captureId, revision: 1, title: "未完草稿", content: "保留正文" };
  const onTaskChange = vi.fn();
  const { container } = render(<KnowledgeView active onTaskChange={onTaskChange} />);
  await screen.findByRole("button", { name: /待处理/ });
  const scroll = container.querySelector('[class*="scroll"]') as HTMLElement;
  scroll.scrollTop = 221;
  fireEvent.click(screen.getByRole("button", { name: /待处理/ }));
  fireEvent.click(screen.getByRole("button", { name: /^继续写/ }));
  await screen.findByRole("textbox", { name: /^标题/ });
  expect(onTaskChange).toHaveBeenLastCalledWith(true);
  fireEvent.click(screen.getByRole("button", { name: "返回并保留草稿" }));
  await screen.findByRole("button", { name: /待处理/ });
  expect(scroll.scrollTop).toBe(221);
  expect(onTaskChange).toHaveBeenLastCalledWith(false);
});
