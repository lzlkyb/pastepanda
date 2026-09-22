/**
 * vitest 里 `@tauri-apps/api/window` 的替身（经 vitest.config.ts 的 resolve.alias 生效）。
 *
 * 批7 起工作台是自绘标题栏，`RcWindowControls` 会读 `isMaximized` 并挂 `onResized`
 * ——缺这两条，任何渲染到标题栏的测试都会在 effect 里抛 TypeError。这里给最朴素的
 * 实现，只保证「不炸」；要断言调用行为的用例自己用 `vi.mock` 覆盖整模块
 * （先例见 `src/__tests__/rcWorkbenchClose.test.tsx` 与
 * `src/components/rc/RcWindowControls.test.tsx`）。
 */
export const getCurrentWindow = () => ({
  setAlwaysOnTop: () => Promise.resolve(),
  hide: () => Promise.resolve(),
  show: () => Promise.resolve(),
  setFocus: () => Promise.resolve(),
  isVisible: () => Promise.resolve(true),
  minimize: () => Promise.resolve(),
  toggleMaximize: () => Promise.resolve(),
  isMaximized: () => Promise.resolve(false),
  close: () => Promise.resolve(),
  destroy: () => Promise.resolve(),
  onResized: () => Promise.resolve(() => {}),
});
