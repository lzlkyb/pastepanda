import { fireEvent, render, screen, cleanup, act } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { KnowledgeArticleView } from "./KnowledgeArticleView";
import type { useKnowledgeArticle } from "./useKnowledgeArticle";

vi.mock("../ui/useMobileBack",()=>({useMobileBack:vi.fn()}));
vi.mock("./KnowledgeArticleMetadata",()=>({KnowledgeArticleMetadata:()=>null}));
afterEach(()=>{cleanup();vi.restoreAllMocks();});

it("manual input during clipboard permission is preserved when the clipboard reply arrives",async()=>{
  let reply!:(text:string)=>void;
  Object.defineProperty(navigator,"clipboard",{configurable:true,value:{readText:()=>new Promise<string>(done=>{reply=done;})}});
  const begin=vi.fn();
  const article={task:null,busy:false,saving:false,error:"",begin,close:vi.fn()} as unknown as ReturnType<typeof useKnowledgeArticle>;
  render(<KnowledgeArticleView article={article} active />);
  fireEvent.click(screen.getByRole("button",{name:"粘贴链接"}));
  fireEvent.change(screen.getByLabelText("文章链接"),{target:{value:"https://example.com/manual"}});
  await act(async()=>{reply("https://example.com/old-clipboard");});
  expect((screen.getByLabelText("文章链接") as HTMLTextAreaElement).value).toBe("https://example.com/manual");
  expect(begin).not.toHaveBeenCalled();
});

const task={id:"article-a",revision:1,url:"https://example.com/a",title:"文章 A",author:"",body:"正文",images:[],note_id:null,duplicate_note_id:null,saved_link_only:false};
it("article discard requires explicit confirmation and safe keep is the first action",async()=>{
  const discard=vi.fn().mockResolvedValue(true);
  const article={task,busy:false,saving:false,error:"",discard,close:vi.fn(),change:vi.fn()} as unknown as ReturnType<typeof useKnowledgeArticle>;
  render(<KnowledgeArticleView article={article} active />);
  fireEvent.click(screen.getByRole("button",{name:"放弃这次收集"}));
  expect(discard).not.toHaveBeenCalled();expect(screen.getByText(/原分享内容和已有笔记仍保留/)).toBeTruthy();
  const dialog=screen.getByRole("dialog");
  const keep=screen.getByRole("button",{name:"保留文章收集"});const confirm=screen.getByRole("button",{name:"确认放弃文章收集"});
  expect(keep.compareDocumentPosition(confirm)&Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();expect(dialog.contains(keep)).toBe(true);
  fireEvent.click(keep);expect(screen.queryByRole("dialog")).toBeNull();expect(discard).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button",{name:"放弃这次收集"}));fireEvent.click(screen.getByRole("button",{name:"确认放弃文章收集"}));
  await act(async()=>{await Promise.resolve();});expect(discard).toHaveBeenCalledWith("article-a");
});
it("saved article exit preserves the original note instead of offering deletion",()=>{
  const close=vi.fn();const discard=vi.fn();
  const article={task:{...task,note_id:"note-a",saved_link_only:true},busy:false,saving:false,error:"",discard,close,change:vi.fn()} as unknown as ReturnType<typeof useKnowledgeArticle>;
  render(<KnowledgeArticleView article={article} active />);
  expect(screen.queryByRole("button",{name:"放弃这次收集"})).toBeNull();
  fireEvent.click(screen.getByRole("button",{name:"保留原笔记并退出"}));expect(close).toHaveBeenCalled();expect(discard).not.toHaveBeenCalled();
});
