import { expect, it } from "vitest";
import { debugBundlePath } from "./macos-bundle-path.mjs";
it("repairs the default Universal debug app", () => {
  expect(debugBundlePath("/cache", "PastePanda", ["--target", "universal-apple-darwin"], () => "{}")).toBe("/cache/universal-apple-darwin/debug/bundle/macos/PastePanda.app");
});
it("respects inline preview names without touching the stable app", () => {
  expect(debugBundlePath("/cache", "PastePanda", ["--config", '{"productName":"PastePanda AV1 Preview"}'], () => "{}")).toBe("/cache/debug/bundle/macos/PastePanda AV1 Preview.app");
});
it("applies file and inline configs in order with equals-form target", () => {
  expect(debugBundlePath("/cache", "PastePanda", ["--target=x86_64-apple-darwin", "--config=first.json", "--config", '{"productName":"Final"}'], () => '{"productName":"First"}')).toBe("/cache/x86_64-apple-darwin/debug/bundle/macos/Final.app");
});
it("rejects paths posing as names", () => {
  expect(() => debugBundlePath("/cache", "PastePanda", ["--config", '{"productName":"../Other"}'], () => "{}")).toThrow("product name");
});
