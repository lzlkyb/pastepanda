import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Card } from "./CardView";
import type { HistoryItem } from "@/stores/appStore";
import styles from "../CardList.module.css";

vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("./CardActionBar", () => ({ CardActionBar: () => null }));
const item = { id: "selection", type: "text", text: "当前位置", time: Date.now(), pinned: false, tags: [] } as unknown as HistoryItem;
const props = { item, selected: true, index: 0, onClick: vi.fn(), onDoubleClick: vi.fn() };
afterEach(cleanup);

it("多选勾选与当前位置独立，只有当前项进入 Tab 顺序", () => {
  const { rerender } = render(<Card {...props} current={false} checked />);
  expect(screen.getByRole("option").tabIndex).toBe(-1);
  expect(screen.getByLabelText("已多选")).toBeTruthy();
  expect(screen.getByRole("option").classList.contains(styles.current)).toBe(false);
  rerender(<Card {...props} current checked />);
  expect(screen.getByRole("option").tabIndex).toBe(0);
  expect(screen.getByRole("option").classList.contains(styles.current)).toBe(true);
});

it("普通当前项没有多选勾选；移走后旧项立即失去当前样式", () => {
  const { rerender } = render(<Card {...props} current checked={false} />);
  expect(screen.queryByLabelText("已多选")).toBeNull();
  rerender(<Card {...props} selected={false} current={false} checked={false} />);
  expect(screen.getByRole("option").classList.contains(styles.current)).toBe(false);
});

it("鼠标选中后立即按键移走，不留下独立的点击背景", () => {
  const { rerender } = render(<Card {...props} current />);
  fireEvent.mouseDown(screen.getByRole("option"), { button: 0 });
  rerender(<Card {...props} selected={false} current={false} />);
  expect(screen.getByRole("option").className).not.toContain("cardClickFeedback");
});

it("当前位置沿用原有选中底色与柔影，只保留一条清晰圆角内描边", () => {
  const css = readFileSync(resolve("src/components/CardList.module.css"), "utf8");
  const current = css.match(/\.card\.current\s*\{([^}]+)\}/)?.[1];
  expect(current).toBeTruthy();
  expect(current).toContain("outline-offset: -2px");
  expect(current).toContain("background: var(--card-selected-bg)");
  expect(current).toContain("box-shadow: var(--card-selected-shadow)");
  expect(css.match(/\.card:focus-visible\s*\{([^}]+)\}/)?.[1]).toContain("outline: none");
});
