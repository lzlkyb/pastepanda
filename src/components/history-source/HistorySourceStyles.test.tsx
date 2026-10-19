import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

it("来源搜索聚焦时只高亮外层，内部输入框不再出现第二个焦点边框", () => {
  const css = readFileSync(resolve("src/components/history-source/HistorySource.module.css"), "utf8");
  const fixture = document.createElement("div");
  fixture.innerHTML = `<style>${css}</style><div class="panel"><label class="search"><input aria-label="搜索来源应用"></label><button>刷新</button></div>`;
  document.body.append(fixture);
  try {
    const input = fixture.querySelector("input")!;
    input.focus();
    expect(input.matches(":focus-visible")).toBe(true);
    expect(getComputedStyle(input).outline).toBe("none");
    // Removing input's duplicate ring must preserve keyboard focus on other controls.
    const button = fixture.querySelector("button")!;
    button.focus();
    expect(getComputedStyle(button).outline).toContain("2px solid");
  } finally { fixture.remove(); }
});
