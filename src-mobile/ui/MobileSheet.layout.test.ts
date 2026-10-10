import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const css = readFileSync(new URL("./MobileUi.module.css", import.meta.url), "utf8");
function block(source: string, selector: string) {
  return source.split(`${selector} {`)[1]?.split("}")[0] ?? "";
}
// Geometry is verified in the actual component preview. These guards prevent the
// old zero-body/flex-shrunk-actions mechanism from silently being reintroduced.
function assertBudget(source: string) {
  const body = block(source, ".sheetBody"), actions = block(source, ".sheetActions");
  const minimum = body.match(/min-height:\s*([^;]+)/)?.[1].trim();
  expect(minimum).toBeTruthy();
  expect(minimum).not.toMatch(/^0(?:px|rem)?$/);
  expect(body).toMatch(/overflow-y:\s*auto/);
  expect(actions).toMatch(/flex:\s*0\s+0\s+auto|flex-shrink:\s*0/);
  expect(actions).toMatch(/max-height:/);
  expect(actions).toMatch(/overflow-y:\s*auto/);
}
it("短屏幕保留正文空间，并避免按钮被 flex 压缩裁切", () => assertBudget(css));
it("旧的零高度正文与可压缩按钮确实被守卫拒绝", () => {
  expect(() => assertBudget(".sheetBody { min-height: 0; overflow-y: auto; }.sheetActions { flex: 0 0 auto; max-height: 35vh; overflow-y: auto; }")).toThrow();
  expect(() => assertBudget(".sheetBody { min-height: 48px; overflow-y: auto; }.sheetActions { flex: 0 1 auto; max-height: 35vh; overflow-y: auto; }")).toThrow();
});
