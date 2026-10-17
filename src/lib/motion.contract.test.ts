import { readFileSync, readdirSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { MOTION } from "./motion";

const read = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");
describe("motion performance contracts", () => {
  it("CSS and JS share the four approved time bands", () => {
    const css = read("../styles/theme.css");
    for (const [token, seconds] of [["fast", MOTION.fast], ["base", MOTION.base], ["slow", MOTION.panel], ["large", MOTION.large]] as const) {
      expect(Number(css.match(new RegExp(`--motion-${token}:\\s*(\\d+)ms`))?.[1])).toBe(seconds * 1000);
    }
  });
  it("capture roots get policy without importing the Framer runtime or appStore", () => {
    const policy = read("../components/MotionPolicy.tsx");
    expect(policy).not.toMatch(/from ["'](?:framer-motion|.*appStore)["']/);
    const roots = readdirSync(new URL("../", import.meta.url)).filter(path => path.endsWith("main.tsx"));
    for (const path of roots) {
      const source = read(`../${path}`);
      if (source.includes("createRoot")) expect(source).toMatch(/<(?:MotionPolicy|InterfaceMotion)>/);
    }
  });
  it("a global palette commit suppresses descendant transition fan-out", () => {
    const css = read("../styles/theme.css");
    expect(css).toContain(':root[data-theme-changing="true"] *');
    expect(css).toMatch(/\[data-theme-changing="true"\][\s\S]*?transition:\s*none\s*!important/);
  });
  it("recording status and card hovers cannot regain decorative loops", () => {
    const bar = read("../components/recsel/RecControlBar.module.css");
    expect(bar).not.toMatch(/recClockTick|recDotBreath|\binfinite\b/);
    const cards = read("../components/CardList.module.css");
    expect(cards).not.toMatch(/animation:\s*(?:var\(--card-shimmer-anim|pp-ring-spin|emptyFloat)/);
    const list = read("../hooks/useListMotion.ts");
    expect(list).not.toMatch(/requestAnimationFrame|setInterval|lenis\.stop/);
  });
});
