import { describe, it, expect, beforeEach, vi } from "vitest";

// storageMigration 使用模块级 `migrated` 标志，需要每次重新导入
// 使用 vi.resetModules + dynamic import 来重置模块状态
async function freshImport() {
  vi.resetModules();
  return import("@/lib/storageMigration");
}

beforeEach(() => {
  localStorage.clear();
});

describe("migrateLegacyStorageKeys", () => {
  it("migrates old pasteship_* keys to pastepanda_*", async () => {
    localStorage.setItem("pasteship_install_day", "2026-01-01");
    localStorage.setItem("pasteship_shown_tips", "true");
    localStorage.setItem("pasteship_hidden_tip_shown", "1");

    const { migrateLegacyStorageKeys } = await freshImport();
    migrateLegacyStorageKeys();

    expect(localStorage.getItem("pastepanda_install_day")).toBe("2026-01-01");
    expect(localStorage.getItem("pastepanda_shown_tips")).toBe("true");
    expect(localStorage.getItem("pastepanda_hidden_tip_shown")).toBe("1");
    // 旧键已删除
    expect(localStorage.getItem("pasteship_install_day")).toBeNull();
    expect(localStorage.getItem("pasteship_shown_tips")).toBeNull();
    expect(localStorage.getItem("pasteship_hidden_tip_shown")).toBeNull();
  });

  it("does NOT overwrite existing new keys", async () => {
    localStorage.setItem("pasteship_install_day", "old-value");
    localStorage.setItem("pastepanda_install_day", "new-value");

    const { migrateLegacyStorageKeys } = await freshImport();
    migrateLegacyStorageKeys();

    // 新键保留原值
    expect(localStorage.getItem("pastepanda_install_day")).toBe("new-value");
    // 旧键仍被删除
    expect(localStorage.getItem("pasteship_install_day")).toBeNull();
  });

  it("skips keys that don't exist", async () => {
    // 只设一个旧键
    localStorage.setItem("pasteship_shown_tips", "yes");

    const { migrateLegacyStorageKeys } = await freshImport();
    migrateLegacyStorageKeys();

    expect(localStorage.getItem("pastepanda_shown_tips")).toBe("yes");
    // 其他新键不应被创建
    expect(localStorage.getItem("pastepanda_install_day")).toBeNull();
    expect(localStorage.getItem("pastepanda_hidden_tip_shown")).toBeNull();
  });

  it("is idempotent (second call is no-op)", async () => {
    localStorage.setItem("pasteship_install_day", "2026-01-01");

    const { migrateLegacyStorageKeys } = await freshImport();
    migrateLegacyStorageKeys();
    expect(localStorage.getItem("pastepanda_install_day")).toBe("2026-01-01");

    // 模拟：旧键又被写入（不应再迁移）
    localStorage.setItem("pasteship_install_day", "should-not-migrate");
    migrateLegacyStorageKeys();
    // 新键保持第一次迁移的值
    expect(localStorage.getItem("pastepanda_install_day")).toBe("2026-01-01");
  });

  it("handles no legacy keys gracefully", async () => {
    const { migrateLegacyStorageKeys } = await freshImport();
    migrateLegacyStorageKeys(); // 不应抛错
    expect(localStorage.length).toBe(0);
  });
});
