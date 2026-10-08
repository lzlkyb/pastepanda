import { getConfig } from "@testing-library/dom";
import { expect, it } from "vitest";

/**
 * 运行时钉住「jsdom project 真的装上了那两个 setup 文件」。
 *
 * 为什么文件名是 .tsx：环境由扩展名路由（见 vitest.config.ts 的两个 include），
 * .tsx 必然落进 jsdom project。这里测的不是任何组件行为，而是那个 project 的
 * setupFiles 生效没有——文本形态的守卫在 vitestEnvSplit.test.ts，这条管运行时。
 */
it("jsdom 侧 findBy*/waitFor 的默认超时被抬到 3s，且共享 setup 同时执行了", () => {
  expect(getConfig().asyncUtilTimeout).toBe(3_000);
  expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
});
