import { act, renderHook, waitFor, cleanup } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { mobileArticleAckSources, mobileArticleBegin, mobileArticleFetch, mobileArticleGet, mobileArticlePending, mobileArticlePut, mobileArticleSave, type MobileArticle } from "@/lib/api/mobileArticle";
import { useKnowledgeArticle } from "./useKnowledgeArticle";

vi.mock("@/lib/api/mobileArticle", () => ({ mobileArticleAckSources:vi.fn(),mobileArticleBegin:vi.fn(),mobileArticleFetch:vi.fn(),mobileArticleGet:vi.fn(),mobileArticlePending:vi.fn(),mobileArticlePut:vi.fn(),mobileArticleSave:vi.fn() }));
const makeTask = (id="a", fields:Partial<MobileArticle>={}):MobileArticle => ({id,revision:1,url:`https://example.com/${id}`,title:"文章标题",author:"来源",html:"",body:"已取得的正文",remarks:"",folder_id:null,tag_ids:[],images:[],source_ids:[],error:"",note_id:null,duplicate_note_id:null,saved_link_only:false,baseline_title:"",baseline_content:"",...fields});
beforeEach(() => {
  vi.resetAllMocks();
  vi.mocked(mobileArticlePending).mockResolvedValue([]);
  vi.mocked(mobileArticleAckSources).mockImplementation(async id=>makeTask(id,{note_id:"note-a",source_ids:[]}));
  vi.mocked(mobileArticleBegin).mockImplementation(async url=>makeTask(url.split("/").slice(-1)[0]));
  vi.mocked(mobileArticlePut).mockImplementation(async (id,fields)=>({...makeTask(id),...fields,revision:fields.revision+1}));
  vi.mocked(mobileArticleGet).mockImplementation(async id=>makeTask(id));
});
afterEach(() => { cleanup(); vi.useRealTimers(); });

it("an unfinished article is flushed before starting a separate article", async () => {
  const hook=renderHook(()=>useKnowledgeArticle(true,undefined,vi.fn()));
  await act(async()=>{ await hook.result.current.begin("https://example.com/a"); });
  act(()=>hook.result.current.change("remarks","文章A的备注"));
  await act(async()=>{ await hook.result.current.begin("https://example.com/b"); });
  expect(mobileArticlePut).toHaveBeenCalledWith("a",expect.objectContaining({remarks:"文章A的备注"}));
  expect(hook.result.current.task?.id).toBe("b"); expect(hook.result.current.task?.remarks).toBe("");
});

it("a delayed fetch can persist its own task but cannot reopen or replace another page", async () => {
  let resolve!:(value:MobileArticle)=>void;
  vi.mocked(mobileArticleBegin).mockResolvedValue(makeTask("a",{body:""}));
  vi.mocked(mobileArticleFetch).mockImplementation(()=>new Promise(done=>{resolve=done;}));
  const hook=renderHook(()=>useKnowledgeArticle(true,undefined,vi.fn()));
  act(()=>{ void hook.result.current.begin("https://example.com/a"); });
  await waitFor(()=>expect(mobileArticleFetch).toHaveBeenCalledWith("a"));
  await act(async()=>{ await hook.result.current.close(); await hook.result.current.begin(); });
  await act(async()=>{ resolve(makeTask("a",{body:"迟到的正文"})); });
  expect(hook.result.current.open).toBe(true); expect(hook.result.current.task).toBeNull();
});

it("save failure retains content and does not consume the share", async () => {
  const acknowledge=vi.fn(); const onSaved=vi.fn();
  const inbox={items:[{id:"share-a"}],acknowledge} as unknown as Parameters<typeof useKnowledgeArticle>[1];
  const hook=renderHook(()=>useKnowledgeArticle(true,inbox,onSaved));
  await act(async()=>{ await hook.result.current.begin("https://example.com/a"); });
  vi.mocked(mobileArticleSave).mockRejectedValue(new Error("存储空间不足"));
  await act(async()=>{ await hook.result.current.save(false); });
  expect(hook.result.current.task?.body).toBe("已取得的正文"); expect(hook.result.current.open).toBe(true);
  expect(hook.result.current.error).toContain("存储空间不足"); expect(onSaved).not.toHaveBeenCalled(); expect(acknowledge).not.toHaveBeenCalled();
});

it("queue cleanup after save can retry against the same committed note", async () => {
  const acknowledge=vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true); const onSaved=vi.fn();
  const inbox={items:[{id:"share-a"}],acknowledge} as unknown as Parameters<typeof useKnowledgeArticle>[1];
  vi.mocked(mobileArticleBegin).mockResolvedValue(makeTask("a",{source_ids:["share-a"]}));
  vi.mocked(mobileArticleGet).mockResolvedValue(makeTask("a",{note_id:"note-a",source_ids:["share-a"]}));
  vi.mocked(mobileArticleSave).mockResolvedValue({id:"note-a"} as Awaited<ReturnType<typeof mobileArticleSave>>);
  const hook=renderHook(()=>useKnowledgeArticle(true,inbox,onSaved));
  await act(async()=>{ await hook.result.current.begin("https://example.com/a"); await hook.result.current.save(false); });
  expect(hook.result.current.open).toBe(true); expect(hook.result.current.task?.note_id).toBe("note-a");
  await act(async()=>{ await hook.result.current.existing(); });
  expect(mobileArticleSave).toHaveBeenCalledTimes(1); expect(acknowledge).toHaveBeenCalledTimes(2); expect(onSaved).toHaveBeenCalledWith("note-a","已打开已有收藏");
});

it("closing refuses to lose edits when their durable write fails", async () => {
  const hook=renderHook(()=>useKnowledgeArticle(true,undefined,vi.fn()));
  await act(async()=>{ await hook.result.current.begin("https://example.com/a"); });
  act(()=>hook.result.current.change("remarks","尚未落盘的备注"));
  vi.mocked(mobileArticlePut).mockRejectedValue(new Error("写入失败"));
  await act(async()=>{ await hook.result.current.close(); });
  expect(hook.result.current.open).toBe(true); expect(hook.result.current.task?.remarks).toBe("尚未落盘的备注");
  expect(hook.result.current.error).toContain("修改还没有保存");
});
it("opening an existing note holds its task identity until share acknowledgment completes",async()=>{
  let reply!:(ok:boolean)=>void;
  const acknowledge=vi.fn(()=>new Promise<boolean>(done=>{reply=done;}));
  const source={items:[{id:"share-a"}],acknowledge} as unknown as Parameters<typeof useKnowledgeArticle>[1];
  vi.mocked(mobileArticleBegin).mockResolvedValueOnce(makeTask("a",{note_id:"note-a",source_ids:["share-a"]})).mockResolvedValueOnce(makeTask("b",{source_ids:["share-b"]}));
  const hook=renderHook(()=>useKnowledgeArticle(true,source,vi.fn()));
  await act(async()=>{await hook.result.current.begin("https://example.com/a");});
  let operation!:Promise<void>;
  await act(async()=>{operation=hook.result.current.existing();await Promise.resolve();});
  await act(async()=>{await hook.result.current.close();await hook.result.current.begin("https://example.com/b");});
  const before=hook.result.current.task?.id;
  await act(async()=>{reply(true);await operation;});
  expect(before).toBe("a");
  expect(mobileArticleAckSources).toHaveBeenCalledWith("a",["share-a"]);
});
