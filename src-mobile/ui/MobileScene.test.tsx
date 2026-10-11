import { cleanup, render } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { MobileScene } from "./MobileScene";

afterEach(cleanup);
it("分页保留相邻目的地布局，未激活页仍不可操作", () => {
  const view = render(<MobileScene {...{ active: false, paged: true, label: "文件" }}><button>传文件</button></MobileScene>);
  const scene = view.container.querySelector("section")!;
  expect(scene.hidden).toBe(false);
  expect(scene.hasAttribute("inert")).toBe(true);
  expect(scene.getAttribute("aria-hidden")).toBe("true");
});
