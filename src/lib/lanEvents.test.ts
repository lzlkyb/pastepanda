/**
 * 事件名在 Rust 与 TS 两边各存一份，而两边对不上时**不会报任何错**：
 * 后端照发、前端永远收不到，表现为「配对完了列表不刷新」——
 * 恰好就是这一轮要修的那个 bug。所以直接读 Rust 源码比对。
 *
 * 范式照搬 `mcpClients.test.ts` 里的 `rustConst`。
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { LAN_PAIRED_CHANGED } from "./lanEvents";

const RUST_SRC = readFileSync(
  resolve(__dirname, "../../src-tauri/src/lan_sync.rs"),
  "utf-8",
);

/** 从 Rust 源码里拿一个 `pub const NAME: &str = "..."`。拿不到就 throw——
 *  常量被改名/删掉也得让测试红，而不是静默通过。 */
function rustConst(name: string): string {
  const m = RUST_SRC.match(new RegExp(`const ${name}: &str = "([^"]*)"`));
  if (!m) throw new Error(`在 lan_sync.rs 里找不到常量 ${name}`);
  return m[1];
}

describe("局域网事件名两边对齐", () => {
  it("名单变更事件名必须逐字相同", () => {
    expect(LAN_PAIRED_CHANGED).toBe(rustConst("EVENT_PAIRED_CHANGED"));
  });

  it("事件名非空（空串两边也会『相等』，但监听不到任何东西）", () => {
    expect(LAN_PAIRED_CHANGED.length).toBeGreaterThan(0);
  });
});
