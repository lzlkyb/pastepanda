/**
 * touchFeedback — 触摸的本地视觉反馈（波纹 / 光标环 / 充能环），纯 DOM 直写。
 *
 * 从 RcMobileSession 拆出（.tsx ≤300 红线 + 热路径隔离）：这些都在 60fps
 * 手势路径上，绝不进 React 渲染。类名由调用方注入（CSS Modules 哈希后
 * 组件才知道真名）。
 */
export interface TouchFeedbackClasses {
  ripple: string;
  rippleRight: string;
  rippleBig: string;
  cursorRing: string;
  cursorRingOn: string;
  chargeRing: string;
  chargeRingOn: string;
  chargeRingDrag: string;
}

export interface TouchFeedback {
  /** 点按波纹；kind: left=左键(indigo) right=右键(琥珀) big=双击第二击(青)。 */
  ripple(x: number, y: number, kind: "left" | "right" | "big"): void;
  /** 光标环亮起并跟到 (x,y)（client 坐标，换算相对附着面）。 */
  cursorOn(x: number, y: number): void;
  /** 充能环：on=琥珀充能 / drag=绿（左键拖拽中） / off=熄灭。 */
  charge(mode: "on" | "drag" | "off", x?: number, y?: number): void;
}

export function createTouchFeedback(host: {
  /** 手势附着面（未 transform）：波纹挂这里、坐标以此为基准。 */
  surface: () => HTMLElement | null;
  cursorEl: () => HTMLElement | null;
  chargeEl: () => HTMLElement | null;
  classes: TouchFeedbackClasses;
}): TouchFeedback {
  const { classes } = host;

  const place = (el: HTMLElement | null, x: number, y: number) => {
    const surface = host.surface();
    if (!el || !surface) return;
    const r = surface.getBoundingClientRect();
    el.style.left = `${x - r.left}px`;
    el.style.top = `${y - r.top}px`;
  };

  return {
    ripple(x, y, kind) {
      const surface = host.surface();
      if (!surface) return;
      const el = document.createElement("div");
      el.className =
        classes.ripple + (kind === "right" ? ` ${classes.rippleRight}` : kind === "big" ? ` ${classes.rippleBig}` : "");
      place(el, x, y);
      surface.appendChild(el);
      window.setTimeout(() => el.remove(), 500);
    },
    cursorOn(x, y) {
      const el = host.cursorEl();
      place(el, x, y);
      el?.classList.add(classes.cursorRingOn);
    },
    charge(mode, x = 0, y = 0) {
      const el = host.chargeEl();
      if (!el) return;
      if (mode === "off") {
        el.className = classes.chargeRing;
        return;
      }
      place(el, x, y);
      el.className =
        classes.chargeRing + (mode === "on" ? ` ${classes.chargeRingOn}` : ` ${classes.chargeRingDrag}`);
    },
  };
}
