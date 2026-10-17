import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { TransformCard } from "./TransformCard";
import { getTransform } from "@/lib/transforms";

vi.mock("@/hooks/useAiStatus", () => ({ useAiStatus: () => ({ status: "off", model: "" }) }));
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
afterEach(cleanup);
it("heuristic confidence is not displayed as a probability", () => {
  render(<TransformCard t={getTransform("delimited-to-sql-in")!} score={0.85} text="001,002,003" opts={{}} specs={[]} copied={false} onSetOpt={vi.fn()} onCopy={vi.fn()} onPaste={vi.fn()} />);
  expect(screen.queryByText("85%")).toBeNull();
  expect(screen.getByText("适合当前内容")).toBeTruthy();
});
it("weak match is labeled optional, not suitable", () => {
  render(<TransformCard t={getTransform("delimited-to-sql-in")!} score={0.45} text="北京,上海,广州" opts={{}} specs={[]} copied={false} onSetOpt={vi.fn()} onCopy={vi.fn()} onPaste={vi.fn()} />);
  expect(screen.queryByText("适合当前内容")).toBeNull();
  expect(screen.getByText("可选")).toBeTruthy();
});
