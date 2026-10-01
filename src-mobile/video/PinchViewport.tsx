/**
 * PinchViewport — 双指捏合的本地视野容器（design §1 手势⑦ / §4.1）。
 *
 * 只做均匀 scale + translate（transform-origin: 0 0，禁旋转——旋转会破坏
 * getBoundingClientRect 的几何前提，坐标链路零修改的结论就建在这条红线
 * 上，见设计稿 §4.1）。缩放不碰远端：rect 每次触摸现算，transform 已含
 * 在内，点按依然准。
 *
 * 变换走 ref 直写 style（捏合是 60fps 连续操作，不走 setState 重渲染）；
 * 对外暴露命令式 handle：applyPinch（比例 + 中点位移 + 锚点）与 reset。
 */
import { forwardRef, useImperativeHandle, useRef } from "react";
import styles from "./PinchViewport.module.css";
import { PINCH_MAX, PINCH_MIN } from "../session/touchConstants";

export interface PinchViewportHandle {
  /**
   * 应用一帧捏合。ratio 相对捏合起点（1.0 = 距离未变）；midDx/midDy 为中点
   * 平移（容器坐标）；锚点 client 坐标为当前双指中点（缩放围绕它，画面上的
   * 指尖内容不跑）。
   */
  applyPinch(
    ratio: number,
    midDx: number,
    midDy: number,
    anchorClientX: number,
    anchorClientY: number,
  ): void;
  /** 复位 1.0（工具条「画面」键）。 */
  reset(): void;
  getScale(): number;
}

export const PinchViewport = forwardRef<
  PinchViewportHandle,
  {
    children: React.ReactNode;
    /** 手势附着面（未 transform），指针事件监听在这里。 */
    surfaceRef: React.RefObject<HTMLElement | null>;
  }
>(function PinchViewport({ children, surfaceRef }, ref) {
  const containerRef = useRef<HTMLDivElement>(null);
  const wrapperRef = useRef<HTMLDivElement>(null);
  const scale = useRef(1);
  const tx = useRef(0);
  const ty = useRef(0);

  const apply = () => {
    const el = wrapperRef.current;
    if (!el) return;
    el.style.transform = `translate(${tx.current}px, ${ty.current}px) scale(${scale.current})`;
  };

  useImperativeHandle(
    ref,
    () => ({
      applyPinch(ratio, midDx, midDy, anchorClientX, anchorClientY) {
        const container = containerRef.current;
        if (!container) return;
        const next = Math.min(PINCH_MAX, Math.max(PINCH_MIN, scale.current * ratio));
        const k = next / scale.current;
        // 锚点换算到未变换的容器局部坐标（container 本身不被变换）
        const rect = container.getBoundingClientRect();
        const ax = anchorClientX - rect.left;
        const ay = anchorClientY - rect.top;
        // 缩放围绕锚点：锚点在屏幕上不动；中点位移叠加为平移
        tx.current = ax - (ax - tx.current) * k + midDx;
        ty.current = ay - (ay - ty.current) * k + midDy;
        scale.current = next;
        apply();
      },
      reset() {
        scale.current = 1;
        tx.current = 0;
        ty.current = 0;
        apply();
      },
      getScale() {
        return scale.current;
      },
    }),
    [],
  );

  return (
    <div ref={containerRef} className={styles.container}>
      <div
        ref={(el) => {
          wrapperRef.current = el;
          surfaceRef.current = el?.parentElement ?? null;
        }}
        className={styles.wrapper}
      >
        {children}
      </div>
    </div>
  );
});
