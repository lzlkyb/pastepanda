/**
 * useMarkdownFormValues 守卫：预览内 `{{字段}}` 填的值，在正文重渲染
 * （dangerouslySetInnerHTML 整棵子树替换）后必须按 name 回填。
 *
 * 另钉住：表单勾选框（无 data-task-i）必须能原生勾选——点击委托只接管任务勾选框。
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, fireEvent } from "@testing-library/react";
import { MarkdownRenderer } from "@/components/MarkdownRenderer";

afterEach(() => {
  document.body.innerHTML = "";
});

describe("表单填值在正文重渲染后不丢", () => {
  it("input 敲的字在正文变化后按 name 回填", () => {
    const { rerender, container } = render(
      <MarkdownRenderer text={"您好 {{姓名}}，请签字。"} />,
    );
    const input = container.querySelector<HTMLInputElement>('input[name="姓名"]');
    expect(input).not.toBeNull();
    fireEvent.input(input!, { target: { value: "张三" } });
    expect(input!.value).toBe("张三");

    // 正文变化 → 子树整体替换 → 确认拿到的是新节点（防假绿前提）
    rerender(
      <MarkdownRenderer text={"您好 {{姓名}}，请签字。\n\n（第二版：加了一段说明）"} />,
    );
    const input2 = container.querySelector<HTMLInputElement>('input[name="姓名"]');
    expect(input2).not.toBe(input);
    expect(input2!.value).toBe("张三");
  });

  it("勾选状态在正文变化后按 name 回填", () => {
    const { rerender, container } = render(
      <MarkdownRenderer text={"{{同意条款/勾选}}"} />,
    );
    const box = container.querySelector<HTMLInputElement>('input[name="同意条款"]');
    expect(box).not.toBeNull();
    // 模拟勾选：原生 checked 翻转 + change 冒泡（捕获监听记录值）
    box!.checked = true;
    fireEvent.change(box!);
    expect(box!.checked).toBe(true);

    rerender(<MarkdownRenderer text={"{{同意条款/勾选}}（v2）"} />);
    const box2 = container.querySelector<HTMLInputElement>('input[name="同意条款"]');
    expect(box2).not.toBe(box);
    expect(box2!.checked).toBe(true);
  });

  it("没填过的字段不会被凭空回填", () => {
    const { rerender, container } = render(
      <MarkdownRenderer text={"{{姓名}}"} />,
    );
    rerender(<MarkdownRenderer text={"{{姓名}}（v2）"} />);
    const input2 = container.querySelector<HTMLInputElement>('input[name="姓名"]');
    expect(input2).not.toBeNull();
    expect(input2!.value).toBe("");
    expect(input2!.placeholder).toBe("姓名");
  });
});

describe("表单勾选框可原生勾选（点击委托不得接管）", () => {
  it("点 {{x/勾选}} 的勾选框：原生翻转生效", () => {
    const { container } = render(<MarkdownRenderer text={"{{同意条款/勾选}}"} />);
    const box = container.querySelector<HTMLInputElement>('input[name="同意条款"]');
    expect(box).not.toBeNull();
    expect(box!.dataset.taskI).toBeUndefined(); // 前提：表单勾选框不带任务序号
    fireEvent.click(box!);
    expect(box!.checked).toBe(true); // 原生 toggle 未被 preventDefault 拦掉
  });

  it("点任务勾选框（无回调时）：保持只读，不翻转", () => {
    const { container } = render(<MarkdownRenderer text={"- [ ] 任务项"} />);
    const box = container.querySelector<HTMLInputElement>('input[data-task-i]');
    expect(box).not.toBeNull();
    expect(box!.disabled).toBe(true); // 无 onToggleTask = 只读
  });
});
