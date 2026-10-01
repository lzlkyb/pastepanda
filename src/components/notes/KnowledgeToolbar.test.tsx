import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { KnowledgeToolbar } from "./KnowledgeToolbar";
import { NoteLayoutSwitch } from "./NoteLayoutSwitch";

afterEach(cleanup);

describe("知识库工具栏", () => {
  it("三栏下搜索与视图操作分开，且都能直接操作", () => {
    const onKeyword = vi.fn();
    const onLayout = vi.fn();
    render(
      <KnowledgeToolbar
        folderName="全部笔记"
        total={9}
        keyword=""
        onKeyword={onKeyword}
        onNew={vi.fn()}
        newHint="新建空白笔记"
        controls={<NoteLayoutSwitch value="list" onChange={onLayout} />}
        qaEnabled={false}
        mode="search"
        onMode={vi.fn()}
        question=""
        onQuestion={vi.fn()}
        onAsk={vi.fn()}
      />,
    );

    const search = screen.getByRole("textbox", { name: "搜笔记" });
    const views = screen.getByRole("group", { name: "笔记视图" });
    expect(views.contains(search)).toBe(false);
    fireEvent.change(search, { target: { value: "MCP" } });
    expect(onKeyword).toHaveBeenCalledWith("MCP");
    fireEvent.click(within(views).getByRole("button", { name: "网格" }));
    expect(onLayout).toHaveBeenCalledWith("grid");
    expect(screen.queryByRole("button", { name: "问" })).toBeNull();
  });
});
