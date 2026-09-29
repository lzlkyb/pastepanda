import { describe, it, expect } from "vitest";
import { resolveAutoStartupDesync } from "@/lib/autoStartup";

describe("resolveAutoStartupDesync", () => {
  it("配置与实测一致时不做任何动作", () => {
    expect(resolveAutoStartupDesync(true, true)).toEqual({
      action: "none",
      registryEnabled: true,
      message: "",
    });
    expect(resolveAutoStartupDesync(false, false)).toEqual({
      action: "none",
      registryEnabled: false,
      message: "",
    });
  });

  it("配置开但实测关（被任务管理器/清理工具动过）：配置收敛为关，绝不反向改注册表", () => {
    const d = resolveAutoStartupDesync(true, false);
    expect(d.action).toBe("sync-config");
    expect(d.registryEnabled).toBe(false);
    // 守卫不变量：动作用户可见的说明，而不是静默吞掉
    expect(d.message).toContain("禁用");
  });

  it("配置关但实测开（残留条目）：配置收敛为开", () => {
    const d = resolveAutoStartupDesync(false, true);
    expect(d.action).toBe("sync-config");
    expect(d.registryEnabled).toBe(true);
    expect(d.message).toContain("开启");
  });

  it("返回值只可能是 none / sync-config 两种——前端没有写注册表的对账动作", () => {
    for (const configEnabled of [true, false]) {
      for (const registryEnabled of [true, false]) {
        const d = resolveAutoStartupDesync(configEnabled, registryEnabled);
        expect(["none", "sync-config"]).toContain(d.action);
      }
    }
  });
});
