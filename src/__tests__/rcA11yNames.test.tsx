/**
 * rc 目录「被读屏丢弃的名称」守卫（2026-09-27 审计 P1-3）。
 *
 * # 缺陷
 *
 * `aria-label` 挂在**隐式 role = generic** 的 `div` / `span` 上。ARIA 规定
 * generic **不允许被命名**（Name From: prohibited）⇒ 浏览器与读屏直接忽略该属性。
 * 属性在 DOM 里、名字不在无障碍树里：
 *
 * | 位置 | 读屏实际听到 |
 * |---|---|
 * | `RcWindowControls` 容器 | 三颗孤立按钮，看不出是一组窗口控制 |
 * | `RcHud` 面板 | 只是一堆文字，不是可命名的「连接详情」地标 |
 * | `RcPageFiles` 目标组 | 按钮组没有组名 |
 * | `RcPageFiles` 在线圆点 | 只听得到设备名，听不出在线与否 |
 * | `RcA2Sidebar` 传输角标 | **一个裸数字** |
 *
 * # 为什么分三层验
 *
 * ① **源码 AST 扫描**（下面第一个 describe）：这类缺陷的**同类面**才是重点
 *    （AGENTS 规则 11.1：第 N 个调用点新写出来时还会不会走错）。用 TypeScript
 *    自己的解析器走 JSX，只认「div / span（含 `motion.div` 这类成员表达式）
 *    带 aria-label 且整条标签里没有 role」——按行 grep 会被跨行属性骗
 *    （`RcFilePanel` / `RcPendingWait` 的 `role="progressbar"` 就在下一行）。
 *
 * ② **可访问名称断言**（角色类修复）：`getByRole(role, { name })`。这三处
 *    修好之后会**先**失败，加 role 才绿，所以它们是能变红的。
 *
 * ③ 🔴 **结构断言**（角标 / 圆点）：⚠️ 这两处**不能**只靠名称断言 ——
 *    testing-library 背后的 `dom-accessibility-api` **没有**实现 ARIA 的
 *    「generic 不允许命名」这条规则，把 `aria-label` 挂回 span 上照样算得出名字，
 *    断言会**假绿**（实测：还原修复后这两个用例仍然通过）。
 *    浏览器（Chromium/AXTree）是真的会丢弃的。所以这两处断言的是**修复形态本身**：
 *    视觉元素 `aria-hidden="true"` + 同级一份 `sr-only` 文本。
 *    这类「测试库与浏览器口径不一致」的位置必须写清楚，否则下一个人会以为
 *    名称断言就是全部证据。
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { render, screen, fireEvent, cleanup } from "@testing-library/react";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import type { RcTargetDevice } from "@/lib/api/rc";
import type { UseRc } from "@/hooks/useRc";
import { RcWindowControls } from "@/components/rc/RcWindowControls";
import { RcHud } from "@/components/rc/RcHud";
import { RcPageFiles } from "@/components/rc/RcPageFiles";
import fileStyles from "@/components/rc/RemoteComputer.module.css";

// 文件面板与「名称」无关，且会去拉传输列表 —— 换成空壳，免得把 IO 拖进来。
vi.mock("@/components/rc/RcFilePanel", () => ({ RcFilePanel: () => null }));

const TARGET: RcTargetDevice = {
  node_id: "peer-a",
  name: "工作电脑",
  conn_state: "ready",
  last_seen: Date.now(),
  denied: false,
  source: "rc",
  presence: "live",
  last_path: "lan",
  trusted: false,
  auto_accept: false,
};

afterEach(cleanup);

/* ══════════ ① 同类面：源码 AST 扫描 ══════════ */

describe("P1-3 · 同类面：aria-label 不得挂在无 role 的 div / span 上", () => {
  const DIR = join(process.cwd(), "src", "components", "rc");

  /** 隐式 role = generic 的两个标签。只收这两个：语义标签（section/nav/aside…）
   *  本身可被命名，收进来会造出假阳性。 */
  const GENERIC_TAGS = new Set(["div", "span"]);

  function offenders(): string[] {
    const out: string[] = [];
    for (const f of readdirSync(DIR).filter((f) => f.endsWith(".tsx") && !f.includes(".test."))) {
      const path = join(DIR, f);
      const sf = ts.createSourceFile(path, readFileSync(path, "utf8"), ts.ScriptTarget.Latest, true, ts.ScriptKind.TSX);
      const visit = (node: ts.Node) => {
        if (ts.isJsxOpeningElement(node) || ts.isJsxSelfClosingElement(node)) {
          const tag = node.tagName.getText(sf);
          // `<motion.div>` 这类成员表达式渲染出来仍是 div
          if (GENERIC_TAGS.has(tag.split(".").pop() ?? "")) {
            let hasLabel = false;
            let hasRole = false;
            for (const a of node.attributes.properties) {
              if (!ts.isJsxAttribute(a)) continue; // 展开属性静态看不见
              const nm = a.name.getText(sf);
              if (nm === "aria-label") hasLabel = true;
              if (nm === "role") hasRole = true;
            }
            if (hasLabel && !hasRole) {
              const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf));
              out.push(`${f}:${line + 1} <${tag}>`);
            }
          }
        }
        ts.forEachChild(node, visit);
      };
      visit(sf);
    }
    return out.sort();
  }

  it("rc 目录零违规（改前这里会列出 5 处，含 RcA2Sidebar 的传输角标）", () => {
    expect(offenders()).toEqual([]);
  });
});

/* ══════════ ② 可访问名称：role 类修复 ══════════ */

describe("P1-3 · RcWindowControls：容器可被命名", () => {
  it("窗口三键有组名（不是三颗孤立按钮）", () => {
    render(<RcWindowControls />);
    expect(screen.getByRole("group", { name: "窗口控制" })).toBeTruthy();
    for (const n of ["最小化", "最大化", "关闭"]) {
      expect(screen.getByRole("button", { name: n })).toBeTruthy();
    }
  });
});

describe("P1-3 · RcHud：面板是可命名的地标", () => {
  const base = {
    codec: "H.264",
    fps: 30,
    rttMs: 38,
    quality: "balanced",
    activeQuality: "balanced",
    peerDriven: true,
    scope: "virtual",
    linkState: "connected" as const,
    pathKind: "direct",
    pointerLocked: false,
    frameSize: { w: 1920, h: 1080 },
  };

  it("展开后「连接详情」是一个 region，不是一堆裸文字", () => {
    render(<RcHud {...base} />);
    expect(screen.queryByRole("region", { name: "连接详情" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "连接详情" }));
    expect(screen.getByRole("region", { name: "连接详情" })).toBeTruthy();
  });
});

describe("P1-3 · RcPageFiles：目标设备组有组名", () => {
  it("设备选择器是一组可命名的 group", () => {
    render(
      <RcPageFiles
        rc={{ targets: [TARGET] } as unknown as UseRc}
        selectedPeer="peer-a"
        showTargetPicker
      />,
    );
    expect(screen.getByRole("group", { name: "选择目标设备" })).toBeTruthy();
  });
});

/* ══════════ ③ 结构断言：视觉元素 aria-hidden + sr-only 文本 ══════════ */

describe("P1-3 · RcPageFiles 在线圆点：颜色给眼睛，文字给读屏", () => {
  it("圆点 aria-hidden，供读屏的文字是同级 sr-only（视觉零变化）", () => {
    const { container } = render(
      <RcPageFiles
        rc={{ targets: [TARGET] } as unknown as UseRc}
        selectedPeer="peer-a"
        showTargetPicker
      />,
    );
    const btn = container.querySelector<HTMLButtonElement>(`.${fileStyles.fileTarget}`)!;
    const dot = btn.querySelector(`.${fileStyles.fileTargetDot}`)!;
    expect(dot.getAttribute("aria-hidden")).toBe("true");
    expect(dot.hasAttribute("aria-label")).toBe(false);
    expect(btn.querySelector(".sr-only")?.textContent).toBe("在线");

    cleanup();
    const { container: c2 } = render(
      <RcPageFiles
        rc={{ targets: [{ ...TARGET, presence: "unknown" }] } as unknown as UseRc}
        selectedPeer="peer-a"
        showTargetPicker
      />,
    );
    const btn2 = c2.querySelector<HTMLButtonElement>(`.${fileStyles.fileTarget}`)!;
    expect(btn2.querySelector(".sr-only")?.textContent).toBe("未确认在线");
  });
});
