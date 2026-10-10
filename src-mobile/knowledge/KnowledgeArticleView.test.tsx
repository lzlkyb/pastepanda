import { fireEvent, render, screen, cleanup, act } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { KnowledgeArticleView } from "./KnowledgeArticleView";
import type { useKnowledgeArticle } from "./useKnowledgeArticle";

vi.mock("../ui/useMobileBack",()=>({useMobileBack:vi.fn()}));
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
