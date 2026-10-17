import { cleanup, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { useViewTransition } from "./useViewTransition";

afterEach(cleanup);

describe("view transitions preserve the latest intent", () => {
  it("first paint is static and thirty rapid selections commit their latest target", () => {
    const { result, rerender } = renderHook(({ view }) => useViewTransition(view), { initialProps: { view: "record" } });
    expect(result.current.phase).toBe("idle");
    const views = ["tools", "knowledge", "record", "settings"];
    for (let index = 0; index < 30; index++) {
      const view = views[index % views.length];
      rerender({ view });
      expect(result.current.shown).toBe(view);
    }
  });
  it("renders the requested view in the same commit, without an exit wait", () => {
    const { result, rerender } = renderHook(({ view }) => useViewTransition(view), {
      initialProps: { view: "record" },
    });
    rerender({ view: "tools" });
    expect(result.current.shown).toBe("tools");
    expect(result.current.phase).not.toBe("out");
  });

  it("a rapid return to the original view cannot leave it in an unclickable exit phase", () => {
    const { result, rerender } = renderHook(({ view }) => useViewTransition(view), {
      initialProps: { view: "record" },
    });
    rerender({ view: "tools" });
    rerender({ view: "record" });
    expect(result.current.shown).toBe("record");
    expect(result.current.phase).not.toBe("out");
  });
});
