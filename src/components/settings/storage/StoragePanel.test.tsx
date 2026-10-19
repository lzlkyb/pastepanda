import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { StoragePanel } from "./StoragePanel";
import { useStorageStats } from "@/hooks/useStorageStats";
import { useSettingsSearch } from "@/hooks/useSettingsSearch";
import { storageDatabase, storageOverview } from "@/__tests__/fixtures/storage";
import styles from "./Storage.module.css";
import settings from "../../Settings.module.css";

vi.mock("@/hooks/useStorageStats", () => ({ useStorageStats: vi.fn() }));
const stats = {
  active: true, overview: storageOverview, database: storageDatabase,
  loading: false, error: "", databaseError: "", stale: false,
  revision: 1, refresh: vi.fn(async () => {}), cancel: vi.fn(),
};
beforeEach(() => {
  vi.mocked(useStorageStats).mockReturnValue(stats);
  vi.mocked(invoke).mockResolvedValue(undefined);
  Element.prototype.scrollIntoView = vi.fn();
});
afterEach(() => { cleanup(); vi.clearAllMocks(); });

describe("存储设置整合", () => {
  it("图表与目录保留，文件及数据库技术明细不再出现", () => {
    const { container } = render(<StoragePanel />);
    expect(screen.getByText("表占用 Top 5")).toBeVisible();
    expect(screen.getByRole("button", { name: "复制路径" })).toBeVisible();
    expect(screen.queryByText("文件占用明细")).not.toBeInTheDocument();
    expect(screen.queryByText("数据库表")).not.toBeInTheDocument();
    expect(container.querySelectorAll("details")).toHaveLength(0);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
  });
  it("复制失败的反馈与目录按钮处于同一可见层", async () => {
    const { container } = render(<StoragePanel />);
    vi.mocked(invoke).mockRejectedValueOnce(new Error("clipboard denied"));
    fireEvent.click(screen.getByRole("button", { name: "复制路径" }));
    expect(await within(container.querySelector(`.${styles.pathRow}`) as HTMLElement).findByText("复制路径失败，请重试。")).toBeVisible();
  });
  it("部分失败不显示完整合计，读取失败不冒充空库", () => {
    vi.mocked(useStorageStats).mockReturnValue({ ...stats, overview: null, database: null, error: "文件占用统计失败，请重试。", databaseError: "表占用统计失败，请重试。" });
    render(<StoragePanel />);
    expect(screen.queryByText("0 B")).not.toBeInTheDocument();
    expect(screen.getByText("文件占用统计失败，请重试。")).toBeVisible();
  });
  it("接入真实设置搜索，数据库关键词找到整个图表区", () => {
    function SearchHarness() {
      const search = useSettingsSearch();
      return <><input aria-label="全局搜索" value={search.filter} onChange={e => search.setFilter(e.target.value)} />
        <div ref={search.containerRef}><div className={settings.sSection}>数据管理</div><StoragePanel />
          <div className={settings.sSection}>其他</div><div className={settings.sRow}>不相关设置</div></div></>;
    }
    const { container } = render(<SearchHarness />);
    fireEvent.change(screen.getByLabelText("全局搜索"), { target: { value: "数据库" } });
    expect(container.querySelector(`.${styles.panel}`)).toBeVisible();
    expect(screen.getByText("不相关设置")).not.toBeVisible();
  });
});
