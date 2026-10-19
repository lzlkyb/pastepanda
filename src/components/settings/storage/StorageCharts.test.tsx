import "@testing-library/jest-dom/vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { StorageCharts, type StorageCategory } from "./StorageCharts";
import { MiB, storageDatabase } from "@/__tests__/fixtures/storage";
import { formatStorageBytes, storageTableBytes } from "@/lib/utils";
import styles from "./Storage.module.css";

afterEach(cleanup);
const categories: StorageCategory[] = [
  { key: "database", label: "数据库", bytes: 136 * MiB, complete: true },
  { key: "images", label: "图片与截图", bytes: 316 * MiB, complete: true },
  { key: "cache", label: "缓存", bytes: 20 * MiB, complete: true },
];
const props = { categories, complete: true, database: storageDatabase, databaseError: "", loading: false };

describe("存储图表", () => {
  it("环图覆盖完整一圈，表比例使用主库而不是文件总量，未知新表仍显示", () => {
    const { container } = render(<StorageCharts {...props} />);
    const arcs = [...container.querySelectorAll(`.${styles.arc}`)];
    expect(arcs).toHaveLength(3);
    const total = arcs.reduce((sum, c) => sum + Number(c.getAttribute("stroke-dasharray")?.split(" ")[0]), 0);
    expect(total).toBeCloseTo(2 * Math.PI * 42);
    expect(screen.getByText("56.3%")).toBeVisible();
    expect(screen.getByText("future_table")).toBeVisible();
    fireEvent.click(screen.getByRole("button", { name: /^数据库/ }));
    expect(container.querySelector(`.${styles.ringValue}`)).toHaveTextContent("29%");
    expect(screen.getByText(/占全部文件的 28.8%/)).toBeVisible();
  });
  it("全部占用直接在图形排行展开，收起后回到前五项", () => {
    const database = { ...storageDatabase, tables: [...storageDatabase.tables, ...Array.from({ length: 4 }, (_, i) => ({ name: `extra_${i}`, table_bytes: MiB, index_bytes: 0, internal_tables: [] }))] };
    const { container } = render(<StorageCharts {...props} database={database} />);
    expect(container.querySelectorAll(`.${styles.rankItem}`)).toHaveLength(5);
    fireEvent.click(screen.getByRole("button", { name: "展开全部 7 项" }));
    expect(container.querySelectorAll(`.${styles.rankItem}`)).toHaveLength(7);
    expect(screen.queryByRole("table")).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole("button", { name: "收起排行" }));
    expect(container.querySelectorAll(`.${styles.rankItem}`)).toHaveLength(5);
  });
  it("不完整的目录统计不画假环图，保留成功的表排行", () => {
    const { container } = render(<StorageCharts {...props} complete={false} categories={categories.map(c => c.key === "images" ? { ...c, bytes: 0, complete: false } : c)} />);
    expect(container.querySelectorAll(`.${styles.arc}`)).toHaveLength(0);
    expect(screen.getByText("未完整")).toBeVisible();
    expect(screen.getByText("剪贴板记录")).toBeVisible();
  });
  it("表占用不支持时保留文件构成，不伪造表大小", () => {
    const { container } = render(<StorageCharts {...props} database={{ ...storageDatabase, size_supported: false }} />);
    expect(container.querySelectorAll(`.${styles.arc}`)).toHaveLength(3);
    expect(screen.queryByText("剪贴板记录")).not.toBeInTheDocument();
    expect(screen.getByText(/暂不支持表占用图表/)).toBeVisible();
  });
  it("零字节表不画最小假柱，空闲页不计为可删除记录", () => {
    const { container } = render(<StorageCharts {...props} database={{ ...storageDatabase, tables: [{ name: "history", table_bytes: 0, index_bytes: 0, internal_tables: [] }] }} />);
    expect(container.querySelectorAll(`.${styles.rankBar}`)).toHaveLength(0);
  });
  it("IEC 标签沿用公共字节计算，缺失索引数据不当成零", () => {
    expect(formatStorageBytes(MiB)).toBe("1.0 MiB");
    expect(formatStorageBytes(0)).toBe("0 B");
    expect(formatStorageBytes(-1)).toBe("—");
    expect(storageTableBytes({ table_bytes: 4096, index_bytes: null })).toBeNull();
  });
});
