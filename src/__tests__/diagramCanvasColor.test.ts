import { readdirSync, readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { THEMES } from "@/lib/theme";

const css = readFileSync("src/styles/theme.css", "utf8");

describe("流程图画布底色", () => {
  it("所有样式的 color-mix 都不能把场景渐变 --app-bg 当作颜色", () => {
    const invalid: string[] = [];
    for (const name of readdirSync("src", { recursive: true }).filter((name) => name.endsWith(".css"))) {
      const path = `src/${name}`;
      const source = readFileSync(path, "utf8");
      if (/color-mix\(\s*in\s+[^,]+,\s*var\(--app-bg\b/.test(source)) invalid.push(path);
    }
    expect(invalid).toEqual([]);
  });
  it("color-mix 的输入在每套真实主题中都是颜色，不能引用渐变背景", () => {
    const expression = css.match(/--diagram-canvas-bg:\s*([^;]+);/)?.[1];
    expect(expression).toBeTruthy();
    const tokens = [...expression!.matchAll(/var\((--[\w-]+)/g)].map((m) => m[1]);
    expect(tokens.length).toBeGreaterThan(0);
    for (const theme of THEMES) {
      const block = css.split(`[data-theme="${theme.key}"] {`)[1]?.split("}")[0];
      expect(block, theme.key).toBeTruthy();
      for (const token of tokens) {
        const value = block!.match(new RegExp(`${token}:\\s*([^;]+);`))?.[1];
        expect(value, `${theme.key}: ${token}`).toBeTruthy();
        expect(value, `${theme.key}: ${token} 必须是颜色`).not.toMatch(/gradient\(/);
      }
    }
  });
});
