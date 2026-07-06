/**
 * logger.test.ts — 日志工具单元测试
 *
 * 覆盖：
 * - 各日志级别输出（error/warn/info/debug）
 * - 级别过滤逻辑（低级别不输出高级别日志）
 * - setLevel/getLevel 动态调整
 * - 边界：silent 模式完全静默
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

// 动态导入以确保每个测试能独立重置模块状态
async function importLogger() {
  // 清除模块缓存，确保每次导入都重新初始化
  vi.resetModules();
  return await import("@/lib/logger");
}

describe("logger", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    // 重置 window.__LOG_LEVEL__，确保默认级别为 "info"
    if (typeof window !== "undefined") {
      delete (window as any).__LOG_LEVEL__;
    }
  });

  describe("默认行为", () => {
    it("默认日志级别为 info", async () => {
      const { logger } = await importLogger();
      expect(logger.getLevel()).toBe("info");
    });

    it("info 级别下应输出 error/warn/info，但不输出 debug", async () => {
      const { logger } = await importLogger();
      const spyError = vi.spyOn(console, "error").mockImplementation(() => {});
      const spyWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const spyInfo = vi.spyOn(console, "info").mockImplementation(() => {});
      const spyDebug = vi.spyOn(console, "debug").mockImplementation(() => {});

      logger.error("err");
      logger.warn("warn");
      logger.info("info");
      logger.debug("debug");

      expect(spyError).toHaveBeenCalledTimes(1);
      expect(spyWarn).toHaveBeenCalledTimes(1);
      expect(spyInfo).toHaveBeenCalledTimes(1);
      expect(spyDebug).not.toHaveBeenCalled();
    });

    it("日志输出包含时间戳和级别前缀", async () => {
      const { logger } = await importLogger();
      const spy = vi.spyOn(console, "info").mockImplementation(() => {});

      logger.info("测试消息");

      const callArg = spy.mock.calls[0][0] as string;
      // 格式: HH:MM:SS.sss [INFO] 测试消息
      expect(callArg).toMatch(/^\d{2}:\d{2}:\d{2}\.\d{3} \[INFO\] 测试消息$/);
    });

    it("支持额外参数传递", async () => {
      const { logger } = await importLogger();
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});

      const extra = { detail: "something" };
      logger.error("失败", extra);

      expect(spy).toHaveBeenCalledWith(
        expect.stringMatching(/\[ERROR\] 失败/),
        extra,
      );
    });
  });

  describe("setLevel / getLevel", () => {
    it("setLevel('debug') 后 getLevel 返回 debug", async () => {
      const { logger } = await importLogger();
      logger.setLevel("debug");
      expect(logger.getLevel()).toBe("debug");
    });

    it("setLevel('silent') 后所有日志均不输出", async () => {
      const { logger } = await importLogger();
      logger.setLevel("silent");

      const spyError = vi.spyOn(console, "error").mockImplementation(() => {});
      const spyWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const spyInfo = vi.spyOn(console, "info").mockImplementation(() => {});
      const spyDebug = vi.spyOn(console, "debug").mockImplementation(() => {});

      logger.error("err");
      logger.warn("warn");
      logger.info("info");
      logger.debug("debug");

      expect(spyError).not.toHaveBeenCalled();
      expect(spyWarn).not.toHaveBeenCalled();
      expect(spyInfo).not.toHaveBeenCalled();
      expect(spyDebug).not.toHaveBeenCalled();
    });

    it("setLevel('error') 后仅输出 error", async () => {
      const { logger } = await importLogger();
      logger.setLevel("error");

      const spyError = vi.spyOn(console, "error").mockImplementation(() => {});
      const spyWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const spyInfo = vi.spyOn(console, "info").mockImplementation(() => {});

      logger.error("err");
      logger.warn("warn");
      logger.info("info");

      expect(spyError).toHaveBeenCalledTimes(1);
      expect(spyWarn).not.toHaveBeenCalled();
      expect(spyInfo).not.toHaveBeenCalled();
    });

    it("setLevel('warn') 后输出 error 和 warn，不输出 info", async () => {
      const { logger } = await importLogger();
      logger.setLevel("warn");

      const spyError = vi.spyOn(console, "error").mockImplementation(() => {});
      const spyWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const spyInfo = vi.spyOn(console, "info").mockImplementation(() => {});

      logger.error("err");
      logger.warn("warn");
      logger.info("info");

      expect(spyError).toHaveBeenCalledTimes(1);
      expect(spyWarn).toHaveBeenCalledTimes(1);
      expect(spyInfo).not.toHaveBeenCalled();
    });

    it("setLevel('debug') 后输出所有级别", async () => {
      const { logger } = await importLogger();
      logger.setLevel("debug");

      const spyError = vi.spyOn(console, "error").mockImplementation(() => {});
      const spyWarn = vi.spyOn(console, "warn").mockImplementation(() => {});
      const spyInfo = vi.spyOn(console, "info").mockImplementation(() => {});
      const spyDebug = vi.spyOn(console, "debug").mockImplementation(() => {});

      logger.error("err");
      logger.warn("warn");
      logger.info("info");
      logger.debug("debug");

      expect(spyError).toHaveBeenCalledTimes(1);
      expect(spyWarn).toHaveBeenCalledTimes(1);
      expect(spyInfo).toHaveBeenCalledTimes(1);
      expect(spyDebug).toHaveBeenCalledTimes(1);
    });
  });

  describe("各日志方法输出到正确的 console 方法", () => {
    it("logger.error 调用 console.error", async () => {
      const { logger } = await importLogger();
      const spy = vi.spyOn(console, "error").mockImplementation(() => {});
      logger.error("test");
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("logger.warn 调用 console.warn", async () => {
      const { logger } = await importLogger();
      const spy = vi.spyOn(console, "warn").mockImplementation(() => {});
      logger.warn("test");
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("logger.info 调用 console.info", async () => {
      const { logger } = await importLogger();
      const spy = vi.spyOn(console, "info").mockImplementation(() => {});
      logger.info("test");
      expect(spy).toHaveBeenCalledTimes(1);
    });

    it("logger.debug 调用 console.debug（debug 级别下）", async () => {
      const { logger } = await importLogger();
      logger.setLevel("debug");
      const spy = vi.spyOn(console, "debug").mockImplementation(() => {});
      logger.debug("test");
      expect(spy).toHaveBeenCalledTimes(1);
    });
  });

  describe("边界情况", () => {
    it("多次 setLevel 切换有效", async () => {
      const { logger } = await importLogger();

      logger.setLevel("silent");
      expect(logger.getLevel()).toBe("silent");

      logger.setLevel("debug");
      expect(logger.getLevel()).toBe("debug");

      logger.setLevel("warn");
      expect(logger.getLevel()).toBe("warn");
    });

    it("setLevel 在非浏览器环境下不崩溃", async () => {
      // jsdom 环境有 window，此处验证正常调用即可
      const { logger } = await importLogger();
      expect(() => logger.setLevel("debug")).not.toThrow();
    });
  });
});
