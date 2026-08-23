import { vi } from "vitest";

export const listen = vi.fn().mockResolvedValue(() => {});

// ScreenshotOverlay 的长截图循环会 emit 进度事件。不导出它的话调用点拿到 undefined，
// `void emit(...)` 抛 TypeError 并被外层 try/catch 吞掉 —— 测试会静默走进错误分支，
// 看起来"通过"其实测的是失败路径。
export const emit = vi.fn().mockResolvedValue(undefined);
