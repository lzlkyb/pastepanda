/**
 * 可控 ResizeObserver + 可注入的盒子尺寸（jsdom 专用测试脚手架）。
 *
 * 为什么需要它：录屏控制条的**窗口尺寸来源**在 2026-10-16 从「TS 里算出来的常量」
 * 改成了「量 `.surface` 的实测盒子」（RecControlBar 的尺寸 effect）。jsdom 没有排版，
 * `offsetWidth` / `offsetHeight` 恒为 0，也不带 ResizeObserver——两者都缺，新口径
 * 就没法在单测里被驱动，只能退回「断言那几个常量」，而那几个常量已经不存在了。
 *
 * 设计取舍：
 * ① 回调**只在测试主动 `flushResize()` 时触发**，不自动回调。jsdom 里任何「自动」
 *    回调都只会喂出假尺寸（0 或某个凭空捏的数），那种绿是没有信息量的。
 * ② 盒子尺寸按元素存在 `WeakMap` 里，`offsetWidth/offsetHeight` 的 getter **懒装**
 *    （第一次 `stubBox` 才挂到 `HTMLElement.prototype`）：没 opt-in 的测试看到的
 *    仍然是 jsdom 原生的 0，行为与改动前完全一致。
 * ③ 登记的 target 由 observer 的 `observe()` 收——测试因此可以**不按 class 名**
 *    拿到「组件真正交给 observer 的那个节点」。CSS Modules 的类名在测试里是带哈希的
 *    （vite 的 `_name_hash`），按类名取节点等于把测试钉在构建细节上。
 *
 * ⚠️ 它只管 jsdom 的缺件，不替代真渲染核对：真窗口尺寸与浮条尺寸是否一致，
 * 仍要在真实 Tauri 窗口上量（窗口外框 − 客户区那条差值判据）。
 */

type Box = { w: number; h: number };

const boxes = new WeakMap<Element, Box>();
let layoutShimInstalled = false;

/** 把 `offsetWidth` / `offsetHeight` 换成「查表」，未登记的元素仍然回 0。 */
function installLayoutShim(): void {
  if (layoutShimInstalled) return;
  layoutShimInstalled = true;
  const props = [
    ["offsetWidth", "w"],
    ["offsetHeight", "h"],
  ] as const;
  for (const [prop, key] of props) {
    Object.defineProperty(HTMLElement.prototype, prop, {
      configurable: true,
      get(this: HTMLElement) {
        return boxes.get(this)?.[key] ?? 0;
      },
    });
  }
}

/**
 * 给元素「量」一个固定盒子。**不要拿它复刻旧实现的那几个常量**
 * （260/288/80/104/128 × 28/36）——桩值与被测实现的期望值撞上，守卫就分不清
 * 「代码真的按 DOM 报了」和「代码又退回硬编码公式了」。挑旧公式算不出的数。
 */
export function stubBox(el: Element, w: number, h: number): void {
  installLayoutShim();
  boxes.set(el, { w, h });
}

type Registration = { cb: ResizeObserverCallback; targets: Element[] };

/** 仍活着的登记（`disconnect()` 后即移除，与浏览器语义一致）。 */
const registrations = new Set<Registration>();

class ControllableResizeObserver {
  private registration: Registration;

  constructor(cb: ResizeObserverCallback) {
    this.registration = { cb, targets: [] };
    registrations.add(this.registration);
  }

  observe(target: Element): void {
    this.registration.targets.push(target);
  }

  unobserve(target: Element): void {
    this.registration.targets = this.registration.targets.filter((t) => t !== target);
  }

  disconnect(): void {
    this.registration.targets = [];
    registrations.delete(this.registration);
  }
}

/** 装到 `globalThis`（幂等；已有实现时不覆盖）。 */
export function installResizeObserver(): void {
  if (!("ResizeObserver" in globalThis)) {
    (globalThis as unknown as { ResizeObserver: unknown }).ResizeObserver = ControllableResizeObserver;
  }
}

/** 按登记顺序列出所有仍被观察的元素（最新的在最后）。 */
export function observedTargets(): Element[] {
  return [...registrations].flatMap((r) => r.targets);
}

/**
 * 最近一次 `observe()` 的那个元素——即「当前这一屏参与尺寸上报的节点」。
 * 组件换渲染分支时会重挂 `.surface`，所以每次分支切换后要重新取一次。
 */
export function lastObservedTarget(): Element | undefined {
  const all = observedTargets();
  return all[all.length - 1];
}

/** 触发所有存活 observer 的回调（同步；调用方负责 act 掉后续微任务）。 */
export function flushResize(): void {
  for (const reg of [...registrations]) {
    reg.cb([], undefined as unknown as ResizeObserver);
  }
}

/** 清空登记（`beforeEach` 用；`stubBox` 的 WeakMap 跟着元素一起消失，不用清）。 */
export function resetResizeObserver(): void {
  registrations.clear();
}
