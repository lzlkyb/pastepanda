/**
 * 「前端会拦窗口关闭」⇒「那扇窗必须拿到 `core:window:allow-destroy`」的对账守卫。
 *
 * 🔴 复现的 bug（2026-09-26 用户报）：「打开 md 全屏编辑器 → 点关闭按钮 → 页面空白」。
 *    真因既不是动画、也不是渲染分支，而是**权限**：
 *    `@tauri-apps/api` 的 `onCloseRequested` 在「没 preventDefault」时，收尾由它自己
 *    `await this.destroy()` 完成（`window.js` 的实现里白纸黑字），而 `destroy` 打的是
 *    `plugin:window|destroy`，需要 `core:window:allow-destroy`。
 *    `default.json` 只给了 `core:window:allow-close` —— 于是窗口**永远销毁不掉**：
 *    Rust 的 `window.close()` 只负责发 CloseRequested、不等结果就返回 Ok，
 *    wrapper 内部 destroy 的拒绝又被它自己吞掉 ⇒ 前端拿不到任何异常，
 *    而退场动画已经把内容淡成 `opacity: 0` —— 用户面对的是一扇关不掉的白窗口。
 *
 *    同一门课 2026-09-18 在 rc-workbench 上已经上过一遍（见
 *    `src/hooks/useRcWorkbenchClose.ts` 文件头 + `capabilities/rc-workbench.json`），
 *    多标签改造给 md-editor 加监听时又漏了一次 ⇒ 把这条约束变成机器可查，别再漏第三次。
 *
 * 为什么扫源码 + 扫 capability JSON，而不是真去关一次窗口：
 * 这条约束的本质就是「源码里注册了监听」×「配置文件里给了权限」两处字面量的一致性。
 * 真关窗口要 WebView2 + Tauri 运行时，vitest 里全是桩（`@tauri-apps/api/window` 被
 * alias 到 `src/__mocks__/`），必然测不到 —— 那层由 `npm run tauri dev` 手测兜。
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";

const ROOT = process.cwd();
const SRC = join(ROOT, "src");
const CAPS = join(ROOT, "src-tauri", "capabilities");

const DESTROY_PERM = "core:window:allow-destroy";

/**
 * 前端注册了 `onCloseRequested` 的模块 → 它跑在哪扇窗上。
 *
 * ❗ 新增任何一处 `onCloseRequested` 都必须在这里登记：下面反向那条会红，
 *    而不是等到用户点关闭发现窗口关不掉。
 */
const CLOSE_LISTENERS: ReadonlyArray<{ file: string; windowLabel: string }> = [
  {
    file: "src/components/editors/fullscreen/useEditorCloseGuard.ts",
    windowLabel: "md-editor",
  },
  {
    file: "src/hooks/useRcWorkbenchClose.ts",
    windowLabel: "rc-workbench",
  },
];

interface Cap {
  file: string;
  windows: string[];
  permissions: string[];
}

function capabilities(): Cap[] {
  return readdirSync(CAPS)
    .filter((f) => f.endsWith(".json"))
    .map((f) => {
      const raw = JSON.parse(readFileSync(join(CAPS, f), "utf8")) as {
        windows?: string[];
        permissions?: Array<string | { identifier?: string }>;
      };
      return {
        file: f,
        windows: raw.windows ?? [],
        permissions: (raw.permissions ?? []).map((p) =>
          typeof p === "string" ? p : (p.identifier ?? ""),
        ),
      };
    });
}

/** 递归收集 src 下的 .ts / .tsx */
function sourceFiles(dir: string, acc: string[] = []): string[] {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    if (statSync(p).isDirectory()) sourceFiles(p, acc);
    else if (/\.tsx?$/.test(name)) acc.push(p);
  }
  return acc;
}

/**
 * 真正**调用** `onCloseRequested` 的位置（注释与文档串里提到它的不算）。
 * 注释过滤按行首判断，够用 —— 本仓没有把调用写在块注释同一行的写法。
 */
function listenerCallSites(): string[] {
  const hits: string[] = [];
  for (const p of sourceFiles(SRC)) {
    const rel = relative(ROOT, p).split(sep).join("/");
    if (rel.includes("/__tests__/") || rel.includes("/__mocks__/")) continue;
    for (const line of readFileSync(p, "utf8").split(/\r?\n/)) {
      const t = line.trim();
      if (t.startsWith("*") || t.startsWith("//") || t.startsWith("/*")) continue;
      if (/\.onCloseRequested\s*\(/.test(line)) hits.push(rel);
    }
  }
  return hits;
}

describe("关闭监听的窗口权限对账", () => {
  it("登记表里的每个文件确实注册了 onCloseRequested（表格不能腐烂）", () => {
    for (const { file } of CLOSE_LISTENERS) {
      const p = join(ROOT, file);
      expect(existsSync(p), `登记的文件不存在：${file}`).toBe(true);
      expect(readFileSync(p, "utf8"), `${file} 里找不到 onCloseRequested 调用`).toMatch(
        /\.onCloseRequested\s*\(/,
      );
    }
  });

  it("每个会拦窗口关闭的窗口都被授予 core:window:allow-destroy", () => {
    const caps = capabilities();
    // 先确认真的读到了配置，否则路径一变这条就空跑不报错。
    expect(caps.length, "capabilities 目录读不到任何 json（锚点错了？）").toBeGreaterThan(0);

    const missing = CLOSE_LISTENERS.filter(
      ({ windowLabel }) =>
        !caps.some(
          (c) => c.windows.includes(windowLabel) && c.permissions.includes(DESTROY_PERM),
        ),
    ).map((l) => l.windowLabel);

    expect(
      missing,
      `这些窗口注册了 onCloseRequested 却没给 ${DESTROY_PERM}，点关闭将永远关不掉窗口：${missing.join(", ")}`,
    ).toEqual([]);
  });

  it("反向：src 下每一处 onCloseRequested 调用都在登记表里", () => {
    const hits = listenerCallSites();
    // 一个都没扫到 ⇒ 正则或注释过滤写坏了，不是「没有监听」。
    expect(hits.length, "一个调用点都没扫到，扫描逻辑坏了").toBeGreaterThanOrEqual(
      CLOSE_LISTENERS.length,
    );

    const registered = new Set(CLOSE_LISTENERS.map((l) => l.file));
    const unregistered = [...new Set(hits)].filter((f) => !registered.has(f));

    expect(
      unregistered,
      `这些文件注册了 onCloseRequested 却没登记，其窗口可能没给 ${DESTROY_PERM}：${unregistered.join(", ")}`,
    ).toEqual([]);
  });
});
