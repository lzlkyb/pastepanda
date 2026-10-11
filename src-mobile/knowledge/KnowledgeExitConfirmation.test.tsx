import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { KnowledgeEditor } from "./KnowledgeEditor";
import { KnowledgeEditPanel } from "./KnowledgeEditPanel";
import type { useKnowledgeDraft } from "./useKnowledgeDraft";
import type { useKnowledgeEdit } from "./useKnowledgeEdit";
import { setupMotionClock } from "../ui/mobileMotionTestUtils";

vi.mock("../ui/useMobileBack", () => ({ useMobileBack: vi.fn() }));
vi.mock("./KnowledgeClassification", () => ({ KnowledgeClassification: () => null }));
vi.mock("./KnowledgeMarkdown", () => ({ KnowledgeMarkdown: () => null }));
afterEach(() => { cleanup(); vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it.each(["新建", "修改"])("%s草稿保存失败时保护离开，安全动作默认聚焦；重试成功才离开", async mode => {
  setupMotionClock().reduced.matches = true;
  const flush = vi.fn().mockRejectedValueOnce(new Error("磁盘写入失败")).mockResolvedValueOnce(undefined);
  const back = vi.fn();
  const model = { draft: { title: "尚未保存的标题", content: "这段输入必须保留", folder_id: null, tag_ids: [] },
    flush, saving: false, locked: false, status: "", error: "", update: vi.fn(), save: vi.fn() };
  render(mode === "新建" ? <KnowledgeEditor active draft={model as unknown as ReturnType<typeof useKnowledgeDraft>} onBack={back} onSaved={vi.fn()} />
    : <KnowledgeEditPanel active edit={model as unknown as ReturnType<typeof useKnowledgeEdit>} onBack={back} onSaved={vi.fn()} />);
  fireEvent.click(screen.getByRole("button", { name: "返回并保留草稿" }));
  await waitFor(() => expect(screen.getByRole("dialog").textContent).toContain("草稿尚未保存"));
  expect(back).not.toHaveBeenCalled();
  expect(screen.getByRole("button", { name: "继续编辑" })).toBe(document.activeElement);
  fireEvent.click(screen.getByRole("button", { name: "继续编辑" }));
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect((screen.getByRole("textbox", { name: "内容" }) as HTMLTextAreaElement).value).toBe("这段输入必须保留");
  await act(async () => fireEvent.click(screen.getByRole("button", { name: "返回并保留草稿" })));
  expect(flush).toHaveBeenCalledTimes(2);
  expect(back).toHaveBeenCalledOnce();
});
