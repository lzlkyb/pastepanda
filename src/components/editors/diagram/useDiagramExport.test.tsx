import { act, cleanup, renderHook } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useDiagramExport } from "./useDiagramExport";

const mocks = vi.hoisted(() => ({
  save: vi.fn(),
  writeFile: vi.fn(),
  writeTextFile: vi.fn(),
  toPng: vi.fn(),
  toBlob: vi.fn(),
  toSvg: vi.fn(),
  toast: vi.fn(),
}));
vi.mock("@tauri-apps/plugin-dialog", () => ({ save: mocks.save }));
vi.mock("@tauri-apps/plugin-fs", () => ({ writeFile: mocks.writeFile, writeTextFile: mocks.writeTextFile }));
vi.mock("html-to-image", () => ({ toPng: mocks.toPng, toBlob: mocks.toBlob, toSvg: mocks.toSvg }));
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast: mocks.toast }) }));

function setup() {
  const source = { getDoc: () => ({ version: 1, nodes: [], edges: [] }), fitView: vi.fn() };
  return renderHook(() => useDiagramExport({ current: source }));
}

beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
  document.body.innerHTML = '<div class="react-flow"></div>';
  mocks.save.mockResolvedValue("/audit/flow.png");
  mocks.writeFile.mockResolvedValue(undefined);
  mocks.writeTextFile.mockResolvedValue(undefined);
  mocks.toPng.mockResolvedValue("data:image/png;base64,iVBORw0KGgo=");
  mocks.toBlob.mockResolvedValue({ arrayBuffer: async () => new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]).buffer });
  // The packaged app's connect-src excludes data:. Safari rejects fetching a
  // rendered PNG data URL even though img-src allows displaying it.
  vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Load failed")));
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

describe("流程图导出在桌面 CSP 下的实际保存", () => {
  it("图片不带 WebKit foreignObject 的方块阴影，编码后恢复原画布样式", async () => {
    document.body.innerHTML =
      '<div class="react-flow"><div class="react-flow__node"><div class="node-content" style="transition: box-shadow .18s ease; box-shadow: 0 2px 8px rgba(0,0,0,.2)">Node</div></div></div>';
    const node = document.querySelector<HTMLElement>(".node-content")!;
    const before = node.style.boxShadow;
    mocks.toBlob.mockImplementationOnce(async () => {
      expect(node.style.boxShadow).toBe("none");
      expect(node.style.transition).toBe("none");
      throw new Error("模拟编码失败");
    });
    const { result } = setup();
    await act(async () => {
      const task = result.current[0]("png");
      await vi.runAllTimersAsync();
      await task;
    });
    expect(mocks.toast).toHaveBeenCalledWith("导出失败：模拟编码失败", "error");
    expect(node.style.boxShadow).toBe(before);
    expect(node.style.transition).toBe("box-shadow .18s ease");
  });

  it("PNG 使用画布已解析的主题背景，不把未解析的颜色变量交给 canvas", async () => {
    const el = document.querySelector<HTMLElement>(".react-flow")!;
    el.style.backgroundColor = "rgb(220, 230, 240)";
    el.style.setProperty("--diagram-canvas-bg", "color-mix(in srgb, var(--app-bg) 92%, white)");
    const { result } = setup();
    await act(async () => {
      const task = result.current[0]("png");
      await vi.runAllTimersAsync();
      await task;
    });
    expect(mocks.toBlob.mock.calls[0][1].backgroundColor).toBe("rgb(220, 230, 240)");
  });

  it("SVG 子路径的 CSS 连线样式随图片导出，失败后不残留在画布", async () => {
    document.body.innerHTML =
      '<style>.audit-edge { stroke: rgb(20, 80, 120); stroke-width: 3px; }</style><div class="react-flow"><svg><path class="audit-edge" d="M0 0 L10 10" /></svg></div>';
    const edge = document.querySelector<SVGElement>("path")!;
    mocks.toBlob.mockImplementationOnce(async () => {
      expect(edge.style.stroke).toBe("rgb(20, 80, 120)");
      expect(edge.style.strokeWidth).toBe("3px");
      throw new Error("模拟编码失败");
    });
    const { result } = setup();
    await act(async () => {
      const task = result.current[0]("png");
      await vi.runAllTimersAsync();
      await task;
    });
    expect(mocks.toast).toHaveBeenCalledWith("导出失败：模拟编码失败", "error");
    expect(edge.style.stroke).toBe("");
    expect(edge.style.strokeWidth).toBe("");
  });
  it("不通过 fetch 读取 PNG，仍写入完整 PNG 字节并报告成功", async () => {
    const { result } = setup();
    await act(async () => {
      const task = result.current[0]("png");
      await vi.runAllTimersAsync();
      await task;
    });
    expect(mocks.writeFile).toHaveBeenCalledWith("/audit/flow.png", new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]));
    expect(fetch).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith("已导出到 /audit/flow.png", "success");
    expect(result.current[1]).toBe(false);
  });

  it("系统保存对话框失败时给出可见错误，并允许重试", async () => {
    const { result } = setup();
    mocks.save.mockRejectedValueOnce(new Error("对话框不可用"));
    await act(async () => {
      await result.current[0]("panda");
    });
    expect(mocks.toast).toHaveBeenCalledWith("导出失败：对话框不可用", "error");
    expect(result.current[1]).toBe(false);
    await act(async () => {
      await result.current[0]("panda");
    });
    expect(mocks.writeTextFile).toHaveBeenCalledOnce();
  });

  it("取消保存不渲染、不落盘，解除忙状态", async () => {
    mocks.save.mockResolvedValueOnce(null);
    const { result } = setup();
    await act(async () => {
      await result.current[0]("png");
    });
    expect(mocks.toBlob).not.toHaveBeenCalled();
    expect(mocks.toPng).not.toHaveBeenCalled();
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(mocks.toast).not.toHaveBeenCalled();
    expect(result.current[1]).toBe(false);
  });

  it("PNG 编码无结果时不创建空文件，显示失败并可重试", async () => {
    mocks.toBlob.mockResolvedValueOnce(null);
    const { result } = setup();
    await act(async () => {
      const task = result.current[0]("png");
      await vi.runAllTimersAsync();
      await task;
    });
    expect(mocks.writeFile).not.toHaveBeenCalled();
    expect(mocks.toast).toHaveBeenCalledWith("导出失败：PNG 编码失败", "error");
    expect(result.current[1]).toBe(false);
  });
});
