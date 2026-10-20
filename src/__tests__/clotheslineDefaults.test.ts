import { readFileSync } from "node:fs";
import { describe, it, expect } from "vitest";
import { DEFAULT_CONFIG } from "@/stores/appStore";

/**
 * 晾衣绳自 7.2.12 起是 opt-in（默认关闭）。
 *
 * 这个功能此前未随版本发布过，所以没有「老用户库里存着 true」的存量问题——
 * 把默认值改掉就是完整的改动，不需要启动迁移。
 *
 * 默认值分散在两处前端代码里，必须同口径：
 * - `DEFAULT_CONFIG.clothesline`：设置页开关的初值
 * - `runtime.mjs` 的 `state.enabled`：页面收到首次快照前那一帧的渲染依据
 *
 * Rust 侧 `Snapshot::default()` 由 `clothesline/model.rs` 的
 * `default_is_disabled_and_partial_config_never_overrides_explicit_choice` 钉住，
 * 那是真跑模型的行为断言，不在这里重复 grep 源码。
 */
describe("晾衣绳默认关闭", () => {
  it("前端默认配置是关", () => {
    expect(DEFAULT_CONFIG.clothesline).toBe(false);
  });

  it("页面运行时初值与默认配置同口径（关掉后残留页不先亮一帧绳子）", () => {
    const runtime = readFileSync("src/clothesline/runtime.mjs", "utf8");
    const state = runtime.slice(
      runtime.indexOf("const state = {"),
      runtime.indexOf("get nativeReceiving"),
    );
    expect(state).toMatch(/enabled:\s*false/);
  });
});
