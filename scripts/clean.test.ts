import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, writeFileSync, rmSync, utimesSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { planSafe } from "./clean.mjs";

const DAY = 86400_000;

function touch(dir: string, rel: string, ageDays: number, content = "x") {
  const p = join(dir, rel);
  mkdirSync(join(p, ".."), { recursive: true });
  writeFileSync(p, content);
  const t = new Date(Date.now() - ageDays * DAY);
  utimesSync(p, t, t);
  return p;
}

let root: string;
beforeEach(() => {
  root = join(tmpdir(), `pp-clean-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  mkdirSync(root, { recursive: true });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const has = (plan: { path: string }[], dir: string, rel: string) =>
  plan.some((f) => f.path === join(dir, rel));

describe("planSafe 安全档判据", () => {
  it("根目录装机/探针残留无条件列出", () => {
    touch(root, "new-installed.apk", 0);
    touch(root, "rd_files.json", 0);
    touch(root, "package.json", 0);
    const plan = planSafe({ root });
    expect(has(plan, root, "new-installed.apk")).toBe(true);
    expect(has(plan, root, "rd_files.json")).toBe(true);
    // 反例：不在白名单的根文件绝不进计划
    expect(has(plan, root, "package.json")).toBe(false);
  });

  it("*.pppart 导出中断残留进计划", () => {
    touch(root, "crash-report.pppart", 0);
    expect(has(planSafe({ root }), root, "crash-report.pppart")).toBe(true);
  });

  it("config_backups 只留最近 3 份，第 4 份（最旧）被列", () => {
    touch(root, join("config_backups", "a.json"), 1);
    touch(root, join("config_backups", "b.json"), 2);
    touch(root, join("config_backups", "c.json"), 3);
    expect(planSafe({ root })).toEqual([]);
    touch(root, join("config_backups", "d.json"), 9);
    const plan = planSafe({ root });
    expect(plan.length).toBe(1);
    expect(has(plan, root, join("config_backups", "d.json"))).toBe(true);
  });

  it("keepBackups 可调：keep=1 时 2 份旧备份都进计划", () => {
    touch(root, join("config_backups", "n.json"), 0);
    touch(root, join("config_backups", "o.json"), 5);
    const plan = planSafe({ root, keepBackups: 1 });
    expect(plan.length).toBe(1);
  });

  it("TTL 护栏：3 天内的 .cache 日志不动（在途现场），超龄的才列", () => {
    touch(root, join(".cache", "rc-phone-live.log"), 1);
    touch(root, join(".cache", "rc-phone-session.log"), 10);
    const plan = planSafe({ root });
    expect(has(plan, root, join(".cache", "rc-phone-live.log"))).toBe(false);
    expect(has(plan, root, join(".cache", "rc-phone-session.log"))).toBe(true);
  });

  it("后缀白名单：.cache 顶层非白名单文件与一切子目录绝不进计划", () => {
    touch(root, join(".cache", "rc-phone-connect.js"), 30);
    touch(root, join(".cache", "rc-tauri-dev-reuse.json"), 30);
    touch(root, join(".cache", "npm-promo", "_logs", "old.log"), 30);
    const plan = planSafe({ root });
    expect(plan.length).toBe(0);
  });
});
