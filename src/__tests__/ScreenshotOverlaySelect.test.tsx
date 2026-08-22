/**
 * ScreenshotOverlay · 选区态交互回归测试。
 *
 * 覆盖源码点名的历史 bug：
 * - :3802-3807 selDraft 残留 / 0×0 草稿接管显示 → 蒙版切成 4 段、"单击确定闪一下"
 * - :3147      拖出画布松手 → dragRef/selDraft 永不清除 → 幽灵框
 * - :3129      原地单击应提交当前吸附窗口进标注
 *
 * 坐标说明：jsdom 不做布局，getBoundingClientRect() 恒为 0，dpr=1，
 * 所以 clientX/clientY 直接就是底图物理坐标，事件参数可以照着几何写。
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { fireEvent, cleanup } from "@testing-library/react";
import {
  setupShotEnv,
  cleanupShotEnv,
  renderOverlay,
  flush,
  q,
  qq,
  toolbar,
  type ShotEnv,
} from "./helpers/shotHarness";

let env: ShotEnv;

beforeEach(() => {
  env = setupShotEnv();
});

afterEach(() => {
  cleanup();
  cleanupShotEnv();
});

/** 取挂着 select 态鼠标事件的根元素 */
function root(): HTMLElement {
  const el = q(".shot-root");
  if (!el) throw new Error("shot-root 不存在");
  return el;
}

describe("拖选建立选区", () => {
  it("拖出有效矩形后进入标注态", async () => {
    await renderOverlay();
    expect(toolbar()).toBeNull();

    fireEvent.mouseDown(root(), { clientX: 200, clientY: 150 });
    fireEvent.mouseMove(root(), { clientX: 700, clientY: 550 });
    fireEvent.mouseUp(root());
    await flush();

    expect(toolbar()).toBeTruthy();
  });

  it("0×0 草稿不接管显示：仅按下时不画选区框", async () => {
    await renderOverlay();

    fireEvent.mouseDown(root(), { clientX: 300, clientY: 300 });
    await flush(1);

    // mousedown 瞬间 selDraft 是 0×0 起点。若它接管了显示，
    // 蒙版与选区框会先跳到光标处的小点再跳回 —— 用户看到的就是"单击确定闪一下"。
    expect(q(".sel-rect")).toBeNull();
  });

  it("拖动不足 4px 时草稿不接管显示（与提交门槛同判据）", async () => {
    await renderOverlay();

    fireEvent.mouseDown(root(), { clientX: 300, clientY: 300 });
    fireEvent.mouseMove(root(), { clientX: 302, clientY: 302 });
    await flush(1);

    // 显示门槛与提交门槛必须同判据，都看**原始**拖动距离（DRAG_MIN）。
    //
    // 曾经不是这样：显示门槛判的是 selDraft.w >= 4，而 selDraft 出自 applyMagnet，
    // 它的返回值有 `w: Math.max(4, …)` 兜底（那是防退化矩形，与「拖选算不算有效」无关），
    // 于是鼠标一动门槛就必然成立 → 选区框先塌成光标处 4×4 小点，松手时提交门槛按原始
    // 距离判成「单击」又跳回吸附窗口，用户看到的就是「单击确定闪一下」。
    expect(q(".sel-rect")).toBeNull();
  });

  it("刚按下时不画选区框", async () => {
    await renderOverlay();

    fireEvent.mouseDown(root(), { clientX: 300, clientY: 300 });
    await flush(1);

    expect(q(".sel-rect")).toBeNull();
  });

  it("越过阈值后选区框跟随草稿", async () => {
    await renderOverlay();

    fireEvent.mouseDown(root(), { clientX: 300, clientY: 300 });
    fireEvent.mouseMove(root(), { clientX: 400, clientY: 420 });
    await flush(1);

    const box = q(".sel-rect");
    expect(box).toBeTruthy();
    expect(box!.style.width).toBe("100px");
    expect(box!.style.height).toBe("120px");
  });

  it("抖动后再单击：全程不出现光标处的小方框", async () => {
    // 这是上面那个不一致的用户可见症状，单独钉一条端到端的
    env.setCommand("snap_window_at", () => ({
      win: { x: 300, y: 200, w: 800, h: 600 },
      ctrl: { x: 320, y: 240, w: 700, h: 500 },
    }));
    await renderOverlay();

    fireEvent.mouseMove(root(), { clientX: 500, clientY: 400 });
    await flush();
    const before = q(".sel-rect")!.style.width;

    fireEvent.mouseDown(root(), { clientX: 500, clientY: 400 });
    fireEvent.mouseMove(root(), { clientX: 502, clientY: 401 });
    await flush(1);
    // 抖动期间选区框应仍是吸附到的窗口，而不是塌成小方块
    expect(q(".sel-rect")!.style.width).toBe(before);

    fireEvent.mouseUp(root());
    await flush();
    expect(toolbar()).toBeTruthy();
  });

  it("拖选有效时蒙版切成 4 块围住选区", async () => {
    await renderOverlay();

    fireEvent.mouseDown(root(), { clientX: 200, clientY: 200 });
    fireEvent.mouseMove(root(), { clientX: 600, clientY: 500 });
    await flush(1);

    expect(qq(".shade-block")).toHaveLength(4);
    // 无选区时的入场蒙版应已让位
    expect(q(".shade-enter")).toBeNull();
  });

  it("微小抖动（<4px）且无吸附选区时留在选区态", async () => {
    await renderOverlay();

    fireEvent.mouseDown(root(), { clientX: 500, clientY: 500 });
    fireEvent.mouseMove(root(), { clientX: 501, clientY: 501 });
    fireEvent.mouseUp(root());
    await flush();

    expect(toolbar()).toBeNull();
  });
});

describe("hover 吸附与单击确认", () => {
  it("移动鼠标向后端问吸附目标", async () => {
    await renderOverlay();

    fireEvent.mouseMove(root(), { clientX: 400, clientY: 400 });
    await flush();

    expect(env.countInvoke("snap_window_at")).toBeGreaterThanOrEqual(1);
  });

  it("桌面空白（后端返回 null）时吸附整屏而非全暗无选区", async () => {
    env.setCommand("snap_window_at", () => null);
    await renderOverlay();

    fireEvent.mouseMove(root(), { clientX: 400, clientY: 400 });
    await flush();

    const box = q(".sel-rect");
    expect(box).toBeTruthy();
    // 整屏吸附 → 命中 isFullscreen（≥98%），带 full 类
    expect(box!.className).toContain("full");
  });

  it("吸附到窗口后原地单击进入标注态", async () => {
    env.setCommand("snap_window_at", () => ({
      win: { x: 300, y: 200, w: 800, h: 600 },
      ctrl: { x: 320, y: 240, w: 700, h: 500 },
    }));
    await renderOverlay();

    fireEvent.mouseMove(root(), { clientX: 500, clientY: 400 });
    await flush();
    expect(toolbar()).toBeNull();

    fireEvent.mouseDown(root(), { clientX: 500, clientY: 400 });
    fireEvent.mouseUp(root());
    await flush();

    expect(toolbar()).toBeTruthy();
  });

  it("吸附矩形出界时钳制进屏内，不让蒙版切成 4 段错位", async () => {
    // 后端在高 DPI / 全屏阴影扩展下可能返回负坐标或超界矩形
    env.setCommand("snap_window_at", () => ({
      win: { x: -50, y: -40, w: 3000, h: 2000 },
      ctrl: { x: -50, y: -40, w: 3000, h: 2000 },
    }));
    await renderOverlay();

    fireEvent.mouseMove(root(), { clientX: 500, clientY: 400 });
    await flush();

    const blocks = qq(".shade-block");
    if (blocks.length === 4) {
      // 钳制生效时选区贴满屏幕，上/左两块蒙版厚度为 0
      expect(blocks[0].style.height).toBe("0px");
      expect(blocks[1].style.width).toBe("0px");
    }
    const box = q(".sel-rect");
    expect(box).toBeTruthy();
    expect(box!.className).toContain("full");
  });
});

describe("拖出画布不留幽灵框", () => {
  it("在 window 上松手也会清掉拖拽草稿", async () => {
    await renderOverlay();

    fireEvent.mouseDown(root(), { clientX: 200, clientY: 200 });
    fireEvent.mouseMove(root(), { clientX: 260, clientY: 260 });
    await flush(1);
    expect(q(".sel-rect")).toBeTruthy();

    // 不在元素上松手，而是在 window 上 —— 元素级 onMouseUp 收不到
    fireEvent.mouseUp(window);
    await flush();

    // 拖选有效（60×60 ≥ 4）→ 应正常进标注态，而不是留下悬挂草稿
    expect(toolbar()).toBeTruthy();
  });
});
