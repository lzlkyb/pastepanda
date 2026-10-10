import { useState } from "react";
import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { MobileSheet } from "./MobileSheet";
import { useMobileBack } from "./useMobileBack";
import { useMobileNavigation } from "./useMobileNavigation";

afterEach(async () => {
  cleanup();
  await waitFor(() => expect(history.state?.mobileBackLayer).toBeUndefined());
});

it("同一提交中子详情先注册，返回仍先回列表，再回设备页", async () => {
  function Detail({ active, leave }: { active: boolean; leave: () => void }) {
    useMobileBack(active, leave);
    return active ? <p>笔记正文</p> : null;
  }
  function Shell() {
    const nav = useMobileNavigation(["devices", "knowledge"], "devices", true);
    const [detail, setDetail] = useState(true);
    return <><button onClick={() => nav.selectTab("knowledge")}>进入知识库</button>
      <span>{nav.tab}</span><Detail active={nav.tab === "knowledge" && detail} leave={() => setDetail(false)} /></>;
  }
  render(<Shell />);
  fireEvent.click(screen.getByText("进入知识库"));
  act(() => history.back());
  await waitFor(() => expect(screen.queryByText("笔记正文")).toBeNull());
  expect(screen.getByText("knowledge")).toBeTruthy();
  await waitFor(() => expect(history.state?.mobileBackLayer).toBeTruthy());
  act(() => history.back());
  await waitFor(() => expect(screen.getByText("devices")).toBeTruthy());
});

it("同一提交中打开真实 Sheet，第一次返回关闭它且不排队切页面", async () => {
  function Page({ active }: { active: boolean }) {
    const [open, setOpen] = useState(true);
    return <MobileSheet open={active && open} title="笔记操作" onClose={() => setOpen(false)}>修改正文</MobileSheet>;
  }
  function Shell() {
    const nav = useMobileNavigation(["devices", "knowledge"], "devices", true);
    return <><button onClick={() => nav.selectTab("knowledge")}>进入知识库</button><span>{nav.tab}</span><Page active={nav.tab === "knowledge"} /></>;
  }
  render(<Shell />);
  fireEvent.click(screen.getByText("进入知识库"));
  expect(screen.getByRole("dialog", { name: "笔记操作" })).toBeTruthy();
  act(() => history.back());
  await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  expect(screen.getByText("knowledge")).toBeTruthy();
  await waitFor(() => expect(history.state?.mobileBackLayer).toBeTruthy());
  act(() => history.back());
  await waitFor(() => expect(screen.getByText("devices")).toBeTruthy());
});
