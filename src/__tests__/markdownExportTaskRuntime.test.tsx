/**
 * 导出文件里「任务勾选」的端到端守卫（jsdom）。
 *
 * 为什么要在 jsdom 里真跑一遍运行时：`EXPORT_RUNTIME` 是一段**字符串**，
 * 没有类型检查、没有 import 检查，只有真的 `new Function()` 执行过才知道它有没有
 * 在 `controls()` 里漏掉 `data-pp-task`（漏掉就会被当成表单字段补 `__f0`）、
 * 或者 save/syncAttributes 忘了带上任务。这两处都不会报错，只会静默丢状态。
 *
 * 早于本轮的实现把任务框 `disabled` 掉了，理由写的是「导出侧没有写回通道」。
 * 实际上通道一直在（localStorage + 下载已填版本），禁掉才是假的不可编辑。
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { buildHtmlDocument } from "@/lib/markdown/exportDoc";
import { EXPORT_RUNTIME } from "@/lib/markdown/exportRuntime";

const TASK_BODY =
  `<ul>` +
  `<li><input type="checkbox" data-pp-task="0"> 一</li>` +
  `<li><input checked="" type="checkbox" data-pp-task="1"> 二</li>` +
  `</ul>`;

function mount(
  bodyHtml: string,
  opts: { taskCount?: number; fields?: { name: string; kind: "text"; label: string }[] } = {},
): void {
  const doc = buildHtmlDocument({
    title: "清单",
    bodyHtml,
    css: "",
    rootClass: "md",
    theme: { name: "ocean", vars: {} },
    docId: "ppdoc1",
    fields: opts.fields ?? [],
    taskCount: opts.taskCount ?? 0,
    runtimeJs: EXPORT_RUNTIME,
  });
  document.body.innerHTML = doc.slice(doc.indexOf("<body>") + 6, doc.indexOf("</body>"));
  // 内嵌 <script> 通过 innerHTML 插入不会执行，这里手动跑一次——等价于真打开文件
  new Function(EXPORT_RUNTIME)();
}

function boxes(): HTMLInputElement[] {
  return Array.from(document.querySelectorAll<HTMLInputElement>("input[data-pp-task]"));
}

function stateText(): string {
  return document.getElementById("pp-state")?.textContent ?? "";
}

beforeEach(() => {
  localStorage.clear();
  URL.createObjectURL = vi.fn(() => "blob:pp");
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, "click").mockImplementation(() => {});
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  localStorage.clear();
  document.body.innerHTML = "";
});

describe("导出运行时的任务勾选", () => {
  it("任务框不被当成表单字段（不补 __f0、状态条说的是勾选）", () => {
    mount(TASK_BODY, { taskCount: 2 });
    expect(document.querySelector("[name^='__f']")).toBeNull();
    expect(stateText()).toBe("勾选会自动保存在本机浏览器");
    // 纯任务文档没有「复制填写结果」——没有可复制的键值
    expect(document.querySelector('[data-pp="copy"]')).toBeNull();
  });

  it("任务框即使带了 name 也不进表单值（只按 name 过滤不够）", () => {
    // 正文里手写 HTML、或渲染器将来加了 name，都可能让任务框同时"长得像字段"。
    // 只按 name 过滤会把它算进字段：`__f{n}` 序号与已填值随即整体错位。
    mount(`<input type="checkbox" name="t" data-pp-task="0">`, { taskCount: 1 });
    expect(stateText()).toBe("勾选会自动保存在本机浏览器");
    expect(document.querySelector('[data-pp="copy"]')).toBeNull();
  });

  it("勾一下 → 400ms 防抖后写进独立的 task key（不污染表单值）", () => {
    vi.useFakeTimers();
    mount(TASK_BODY, { taskCount: 2 });
    boxes()[0].checked = true;
    boxes()[0].dispatchEvent(new Event("change", { bubbles: true }));
    vi.advanceTimersByTime(500);

    const raw = localStorage.getItem("pp-task:ppdoc1");
    expect(raw, "任务勾选没有落到 localStorage").toBeTruthy();
    expect(JSON.parse(raw as string)).toEqual({ "0": true, "1": true });
    // 表单 key 里绝不能出现任务（两套状态混在一起会让字段序号整体错位）
    expect(JSON.parse(localStorage.getItem("pp-form:ppdoc1") as string)).toEqual({});
  });

  it("重新打开同一个文件 → 恢复上次勾选", () => {
    vi.useFakeTimers();
    mount(TASK_BODY, { taskCount: 2 });
    boxes()[0].checked = true;
    boxes()[1].checked = false;
    boxes()[0].dispatchEvent(new Event("change", { bubbles: true }));
    vi.advanceTimersByTime(500);

    mount(TASK_BODY, { taskCount: 2 }); // 等价于关掉再双击打开
    expect(boxes()[0].checked).toBe(true);
    expect(boxes()[1].checked).toBe(false);
    expect(stateText()).toBe("已恢复上次填写");
  });

  it("「下载已填版本」把勾选烧回 checked 属性，并写进 pp-data", () => {
    mount(TASK_BODY, { taskCount: 2 });
    boxes()[0].checked = true;
    boxes()[1].checked = false; // 源文里第二项本来是勾上的，这里改掉才能验"属性真的被同步"
    const btn = document.querySelector<HTMLButtonElement>('[data-pp="download"]');
    expect(btn, "纯任务文档没有下载按钮，勾选带不走").toBeTruthy();
    btn!.dispatchEvent(new MouseEvent("click", { bubbles: true }));

    // outerHTML 就是被下载的内容：属性上没 checked，文件里那一项就是空的
    expect(boxes()[0].getAttribute("checked")).not.toBeNull();
    expect(boxes()[1].getAttribute("checked")).toBeNull();

    const data = JSON.parse(document.getElementById("pp-data")!.textContent as string);
    expect(data.tasks).toEqual({ "0": true, "1": false });
    expect(stateText()).toContain("2 项勾选");
  });

  it("普通 checkbox（带 name）仍是表单字段，不受任务分支影响", () => {
    mount(`<input type="checkbox" name="同意">`, {
      fields: [{ name: "同意", kind: "text", label: "同意" }],
    });
    expect(stateText()).toBe("填写内容会自动保存在本机浏览器");
    // 任务分支一个都不该命中
    expect(boxes().length).toBe(0);
    expect(document.querySelector('[data-pp="copy"]')).toBeTruthy();
  });
});

/**
 * 防假绿核对（逐条实跑过，改回错误实现都能精确变红）：
 * - 删掉 `controls()` 里的 `data-pp-task` 跳过 →「任务框即使带了 name 也不进表单值」红
 *   （只按 name 过滤不够：带 name 的任务框会被算成字段）；
 * - 删掉 `save()` 里的 `localStorage.setItem(TASK_KEY, …)` →「勾一下…」与「重新打开…」红；
 * - 删掉 `syncAttributes()` 里的任务段 →「下载已填版本…烧回 checked」红；
 * - 去掉 `applyTasks(...)` 调用 →「重新打开同一个文件 → 恢复上次勾选」红。
 */
