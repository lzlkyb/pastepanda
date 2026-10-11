import { describe, expect, it, vi, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import { EditorState } from "@codemirror/state";
import { forEachDiagnostic } from "@codemirror/lint";
import { EditorView } from "@codemirror/view";
import { validateJson, jsonValidationLabel } from "@/lib/utils";
import { JsonFormatBar, jsonLinter } from "@/components/editors/fullscreen/JsonBody";
import type { ShellBridge } from "@/components/editors/fullscreen/types";

afterEach(() => { cleanup(); vi.restoreAllMocks(); });
describe("WebKit JSON errors without positions", () => {
  it("preserves a positionless WebKit parse error without claiming a line", () => {
    vi.spyOn(JSON, "parse").mockImplementation(() => { throw new SyntaxError("JSON Parse error: Expected '}'"); });
    const result = validateJson('{"n":');
    expect(result.valid).toBe(false);
    expect(result.line).toBeUndefined();
    expect(jsonValidationLabel('{"n":', result)).toBe("✕ JSON 格式错误");
  });
  it("preserves V8 line/position diagnostics and distinguishes an empty editor", () => {
    vi.spyOn(JSON, "parse").mockImplementation(() => { throw new SyntaxError("at position 2 (line 2 column 1)"); });
    expect(validateJson("{\n!").line).toBe(2);
    expect(validateJson("{\n!").position).toBe(2);
    expect(jsonValidationLabel("", validateJson(""))).toBe("等待输入");
  });
  it("accepts valid JSON and returns the original parsed value", () => {
    expect(validateJson('{"n":2}')).toEqual({ valid: true, value: { n: 2 } });
  });
  it("shows format error without an unusable jump link on the actual toolbar", () => {
    vi.spyOn(JSON, "parse").mockImplementation(() => { throw new SyntaxError("JSON Parse error: Expected '}'"); });
    render(<JsonFormatBar bridge={{ text: '{"n":', openSearch: vi.fn(), gotoLine: vi.fn(), replaceDoc: vi.fn() } as unknown as ShellBridge} />);
    expect(screen.getByText("✕ JSON 格式错误").tagName).toBe("SPAN");
    expect(screen.queryByText(/跳转/)).toBeNull();
    expect(screen.queryByText(/第 \? 行/)).toBeNull();
  });
  it("marks a positionless error in the real CodeMirror lint state", async () => {
    vi.spyOn(JSON, "parse").mockImplementation(() => { throw new SyntaxError("JSON Parse error: Expected '}'"); });
    const host = document.createElement("div"); document.body.append(host);
    const view = new EditorView({ parent: host, state: EditorState.create({ doc: '{"n":', extensions: [jsonLinter] }) });
    try {
      const { forceLinting } = await import("@codemirror/lint");
      forceLinting(view);
      await vi.waitFor(() => {
        let count = 0;
        forEachDiagnostic(view.state, (diagnostic, from, to) => {
          count++;
          expect(diagnostic.severity).toBe("error");
          expect([from, to]).toEqual([0, 5]);
        });
        expect(count).toBe(1);
      });
    } finally { view.destroy(); host.remove(); }
  });
});
