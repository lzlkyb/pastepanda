/**
 * 三处提问框接入共用 Composer 之后的行为钉子。
 *
 * 钉的都是**改外壳时最容易静默丢掉**的东西（稿 §5 那列「要保」）：
 *  - KB：「当前范围」从 `.foot` 的独立一行挪进下行的常驻提示位，且 Shift+Enter
 *    仍然只换行不提交、输入法选字的 Enter 不算提交；
 *  - AI 追问：发送钮**保留常驻文字「追问」**（L2），空值禁用，提交后清空；
 *  - 指令条：空值也必须能触发回调（否则「没看懂」的反馈就没了，规则 15.3），
 *    未命中时把原文选中。
 *
 * ❗ 类名一律从 CSS Module 对象取（测试环境里 DOM 上是 `_composerSend_hash`，
 *   写死字面量会一条都命中不了——那就是一条空守卫）。
 */
import { describe, it, expect, vi, afterEach } from "vitest";
import { render, cleanup, fireEvent, screen } from "@testing-library/react";
import { KbQaPanel } from "@/components/notes/KbQaPanel";
import { FollowupInput } from "@/components/ai/FollowupInput";
import { NlCommandBar } from "@/components/NlCommandBar";
import c from "@/components/Composer.module.css";
import nl from "@/components/NlCommandBar.module.css";

/* jsdom 没有 ResizeObserver（test-setup.ts 里也没补），而 KB 面板把 paneRef 交给了
   useAutoGrow → 直接 new 会 ReferenceError。空实现是忠实的：那个回调只往
   textarea 写 inline height，而 jsdom 无布局、clientHeight 恒为 0，真触发也测不出东西。
   本文件钉的是行为与常驻文案，高度归真机点验。 */
class StubResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
(globalThis as { ResizeObserver?: unknown }).ResizeObserver = StubResizeObserver;

afterEach(cleanup);

const q = <T extends Element>(container: HTMLElement, cls: string) =>
  container.querySelector(`.${cls}`) as T | null;
const qa = (container: HTMLElement, cls: string) => container.querySelectorAll(`.${cls}`);

const kbProps = (onAsk = vi.fn()) => ({
  session: { turns: [], pending: null },
  scopeLabel: "只有「剪贴板」这一篇",
  busy: false,
  onAsk,
  onConfirm: vi.fn(),
  onClose: vi.fn(),
  onOpenNote: vi.fn(),
});

describe("知识库追问（提案 1）", () => {
  it("范围说明常驻在输入框下面那一行，而且全页只出现一次", () => {
    const { container } = render(<KbQaPanel {...kbProps()} />);
    expect(q(container, c.composerHint)?.textContent).toBe("当前范围：只有「剪贴板」这一篇");
    expect(q(container, c.composer)).not.toBeNull();
    // 原来那行独立的 .scope 若还留着，同一句话会出现两次。
    // 只数**叶子**元素：祖先链上的每个 div 的 textContent 都以它开头，数整棵树
    // 量的是 DOM 深度不是出现次数（试过一次，得到的是 4）。
    const leaves = [...container.querySelectorAll("*")].filter(
      (e) => e.children.length === 0 && e.textContent?.startsWith("当前范围："),
    );
    expect(leaves).toHaveLength(1);
  });

  it("回车提交；Shift+回车只换行；输入法选字的回车不算提交", () => {
    const props = kbProps();
    const { container } = render(<KbQaPanel {...props} />);
    const ask = container.querySelector("textarea") as HTMLTextAreaElement;
    fireEvent.change(ask, { target: { value: "把来源列出来" } });

    fireEvent.keyDown(ask, { key: "Enter", shiftKey: true });
    expect(props.onAsk).not.toHaveBeenCalled();

    fireEvent.keyDown(ask, { key: "Enter", isComposing: true });
    expect(props.onAsk).not.toHaveBeenCalled();

    fireEvent.keyDown(ask, { key: "Enter" });
    expect(props.onAsk).toHaveBeenCalledWith("把来源列出来");
  });

  it("回答中：输入框与发送钮一起禁用，占位文案换成「正在回答…」", () => {
    const { container } = render(<KbQaPanel {...kbProps()} busy />);
    const ask = container.querySelector("textarea") as HTMLTextAreaElement;
    expect(ask.disabled).toBe(true);
    expect(ask.placeholder).toBe("正在回答…");
    expect(q(container, c.composerSend)?.hasAttribute("disabled")).toBe(true);
  });
});

describe("AI 追问（提案 2）", () => {
  it("发送钮上是常驻文字「追问」，不是裸图标（L2）", () => {
    const { container } = render(<FollowupInput disabled={false} onSubmit={vi.fn()} />);
    const go = q<HTMLButtonElement>(container, c.composerSend);
    expect(go?.textContent).toBe("追问");
  });

  it("空值禁用；有值回车提交并清空", () => {
    const onSubmit = vi.fn();
    const { container, rerender } = render(<FollowupInput disabled={false} onSubmit={onSubmit} />);
    const input = container.querySelector("input") as HTMLInputElement;
    const go = q<HTMLButtonElement>(container, c.composerSend)!;
    expect(go.disabled).toBe(true);

    fireEvent.change(input, { target: { value: "再短一点" } });
    expect(go.disabled).toBe(false);
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onSubmit).toHaveBeenCalledWith("再短一点");

    rerender(<FollowupInput disabled={false} onSubmit={onSubmit} />);
    expect(input.value).toBe("");
  });

  it("跑起来的时候转圈占着发送位（U1 的 >1s 指示）", () => {
    const { container } = render(<FollowupInput disabled onSubmit={vi.fn()} />);
    expect(q(container, c.composerSend)?.querySelector("svg")).not.toBeNull();
  });
});

describe("变换中心指令条（提案 2）", () => {
  it("空值也必须给反馈：点发送照样回调（不能变成「点了没反应」）", () => {
    const onResult = vi.fn();
    const { container } = render(<NlCommandBar onResult={onResult} />);
    const go = q<HTMLButtonElement>(container, c.composerSend)!;
    expect(go.disabled).toBe(false); // ❗ 空值不禁用就是这条
    fireEvent.click(go);
    expect(onResult).toHaveBeenCalledTimes(1);
    expect(onResult.mock.calls[0][0].actionId).toBeFalsy();
  });

  it("命中时清空，方便连着试下一条", () => {
    const onResult = vi.fn();
    const { container } = render(<NlCommandBar onResult={onResult} />);
    const input = container.querySelector("input") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "翻译成英文" } });
    fireEvent.keyDown(input, { key: "Enter" });
    // 这条必须真命中，否则整段退化成下面那条的副本（空守卫）
    expect(onResult.mock.calls[0][0].actionId).toBeTruthy();
    expect(input.value).toBe("");
  });

  it("未命中时把原文选中，让用户改两个词而不是从头再打", () => {
    const onResult = vi.fn();
    const { container } = render(<NlCommandBar onResult={onResult} />);
    const input = container.querySelector("input") as HTMLInputElement;
    const text = "zzz 一条解析器肯定不认识的指令";
    fireEvent.change(input, { target: { value: text } });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(onResult.mock.calls[0][0].actionId).toBeFalsy();
    expect([input.selectionStart, input.selectionEnd]).toEqual([0, text.length]);
  });

  it("图标位还在，且用的是原来那个灯箱（不重设计）", () => {
    const { container } = render(<NlCommandBar onResult={vi.fn()} />);
    expect(q(container, nl.icon)?.querySelector("svg")).not.toBeNull();
    expect(qa(container, c.composerSlim)).toHaveLength(1);
  });
});

describe("Composer 的可达性钩子", () => {
  it("发送钮有无障碍名，输入框有名字", () => {
    render(<NlCommandBar onResult={vi.fn()} />);
    expect(screen.getByRole("button", { name: "执行指令" })).not.toBeNull();
    expect(screen.getByRole("textbox", { name: "自然语言指令" })).not.toBeNull();
  });
});
