import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { AboutTabContent } from "@/components/settings/AboutTabContent";
const state = vi.hoisted(() => ({ status: "idle", update: null as { version: string } | null }));
vi.mock("@/contexts/UpdateContext", () => ({ useUpdate: () => ({ ...state, checkForUpdate: vi.fn() }) }));
vi.mock("@/components/UpdateBadge", () => ({ UpdateBanner: () => null }));
vi.mock("@/components/ChangelogView", () => ({ ChangelogView: () => null }));
vi.mock("@/components/SponsorCard", () => ({ SponsorCard: () => null }));
afterEach(cleanup);
it.each(["idle", "unknown"])("does not assert latest before a successful check (%s)", (status) => {
  state.status = status; state.update = null;
  render(<AboutTabContent appName="PastePanda" appVersion="7.2.10" />);
  expect(screen.queryByText("已是最新")).toBeNull();
  expect(screen.getByText("尚未检查")).toBeTruthy();
});
it("shows latest only for explicit uptodate state", () => {
  state.status = "uptodate"; state.update = null;
  render(<AboutTabContent appName="PastePanda" appVersion="7.2.10" />);
  expect(screen.getByText("已是最新")).toBeTruthy();
});
it("reports a skipped available version instead of claiming latest", () => {
  state.status = "skipped"; state.update = { version: "7.2.11" };
  render(<AboutTabContent appName="PastePanda" appVersion="7.2.10" />);
  expect(screen.queryByText("已是最新")).toBeNull();
  expect(screen.getByText("v7.2.11 已跳过")).toBeTruthy();
});
