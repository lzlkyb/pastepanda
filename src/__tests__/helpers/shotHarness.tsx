/**
 * ScreenshotOverlay 组件级测试夹具。
 *
 * 为什么需要它：这个组件同时依赖 canvas 与 Tauri IPC，jsdom 下有三处会让它卡死或
 * 让覆盖率直接归零 ——
 *   ① `canvas.getContext("2d")` 返回 null。redraw（ScreenshotOverlay:866）判空后早返回，
 *      所以渲染不崩，但一行绘制逻辑都测不到，"画了什么"无法断言。
 *   ② `canvas.toBlob` 未实现。canvasToDataUrl 依赖它，不桩则 Promise 永久 pending，
 *      「完成 / 保存 / 贴图 / 自动打码」整条路都走不到底。
 *   ③ `new Image()` 不解码 data URL，`onload` 永不触发。底图预加载永久挂起，
 *      而马赛克采样、合成、放大镜全要 baseImgRef。
 *
 * 三处各桩一次，此后所有截图组件测试复用同一套，不必各自造轮子。
 */

import { vi } from "vitest";
import { render, act, fireEvent, type RenderResult } from "@testing-library/react";
import { invoke } from "@tauri-apps/api/core";
import { listen, emit } from "@tauri-apps/api/event";
import { setAiAvailabilityForTest } from "@/lib/aiAvailability";
import type { OcrResult } from "@/lib/api/images";
import type { ScreenInfo } from "@/lib/screenshot/types";
import { ScreenshotOverlay } from "@/components/screenshot/ScreenshotOverlay";

/* ===== fixture 构造器 ===== */

/** 默认底图：1920×1080 物理像素，dataUrl 内容不重要（Image 已桩，不会真解码） */
export function screenInfo(patch: Partial<ScreenInfo> = {}): ScreenInfo {
  return {
    dataUrl: "data:image/jpeg;base64,/9j/TEST",
    originX: 0,
    originY: 0,
    width: 1920,
    height: 1080,
    ...patch,
  };
}

/**
 * 构造 OCR 结果。
 *
 * `words` 默认按字符逐个切并给出等宽 bbox —— 自动打码要靠"逐字符 bbox"才能只盖命中子串
 * （ScreenshotOverlay:1473 的 perChar 判定要求 `words.length === [...text].length`）。
 * 传 `perChar: false` 则退化成整行单框，用来测兼容回退分支。
 */
export function ocrResult(
  lines: { text: string; x?: number; y?: number; charW?: number; h?: number }[],
  opts: { perChar?: boolean } = {},
): OcrResult {
  const perChar = opts.perChar !== false;
  return {
    lines: lines.map((l) => {
      const x0 = l.x ?? 100;
      const y0 = l.y ?? 200;
      const cw = l.charW ?? 10;
      const h = l.h ?? 20;
      const chars = Array.from(l.text);
      return {
        text: l.text,
        words: perChar
          ? chars.map((c, i) => ({ text: c, x: x0 + i * cw, y: y0, width: cw, height: h }))
          : [{ text: l.text, x: x0, y: y0, width: chars.length * cw, height: h }],
      };
    }),
    fullText: lines.map((l) => l.text).join("\n"),
  };
}

/* ===== canvas 2D context 桩 ===== */

export interface CtxCall {
  fn: string;
  args: unknown[];
}

export interface StubCtx {
  canvas: HTMLCanvasElement;
  /** 按顺序记录的方法调用 */
  calls: CtxCall[];
  /** 属性写入（fillStyle / lineWidth / font …），保留最后一次的值 */
  props: Record<string, unknown>;
  /** 某方法被调用过几次 */
  count(fn: string): number;
  /** 取第 n 次调用某方法的参数 */
  argsOf(fn: string, nth?: number): unknown[] | undefined;
}

/** 探针取色返回的像素（放大镜 hex 断言用），可在用例里改 */
let probePixel: [number, number, number, number] = [0x12, 0x34, 0x56, 255];

export function setProbePixel(r: number, g: number, b: number, a = 255): void {
  probePixel = [r, g, b, a];
}

function makeStubCtx(canvas: HTMLCanvasElement): StubCtx {
  const calls: CtxCall[] = [];
  const props: Record<string, unknown> = {};

  const rec = (fn: string, args: unknown[], ret?: unknown) => {
    calls.push({ fn, args });
    return ret;
  };

  // 有返回值的方法必须显式给：调用方会读它的字段，返回 undefined 会 TypeError。
  const explicit: Record<string, (...args: unknown[]) => unknown> = {
    getImageData: (...args) => {
      const w = Math.max(1, Math.round(Number(args[2]) || 1));
      const h = Math.max(1, Math.round(Number(args[3]) || 1));
      const data = new Uint8ClampedArray(w * h * 4);
      for (let i = 0; i < data.length; i += 4) {
        data[i] = probePixel[0];
        data[i + 1] = probePixel[1];
        data[i + 2] = probePixel[2];
        data[i + 3] = probePixel[3];
      }
      calls.push({ fn: "getImageData", args });
      return { data, width: w, height: h, colorSpace: "srgb" };
    },
    createImageData: (...args) => {
      const w = Math.max(1, Math.round(Number(args[0]) || 1));
      const h = Math.max(1, Math.round(Number(args[1]) || 1));
      calls.push({ fn: "createImageData", args });
      return { data: new Uint8ClampedArray(w * h * 4), width: w, height: h, colorSpace: "srgb" };
    },
    // wrapLines / measureTextExtent 靠它算换行；给按字符估算的宽度，够稳定可断言
    measureText: (...args) => {
      calls.push({ fn: "measureText", args });
      const s = String(args[0] ?? "");
      return { width: Array.from(s).length * 10 };
    },
    createPattern: (...args) => rec("createPattern", args, { setTransform() {} }),
    createLinearGradient: (...args) =>
      rec("createLinearGradient", args, { addColorStop() {} }),
    createRadialGradient: (...args) =>
      rec("createRadialGradient", args, { addColorStop() {} }),
    isPointInPath: (...args) => rec("isPointInPath", args, false),
    getLineDash: (...args) => rec("getLineDash", args, []),
  };

  const stub: StubCtx = {
    canvas,
    calls,
    props,
    count: (fn) => calls.filter((c) => c.fn === fn).length,
    argsOf: (fn, nth = 0) => calls.filter((c) => c.fn === fn)[nth]?.args,
  };

  // 用 Proxy 兜住"未列举的 2D 方法"：drawAnnot 会用到十几个 canvas API，
  // 逐个手写既啰嗦又会在 draw.ts 新增用法时静默漏掉（那时测试会崩在 undefined 不是函数，
  // 排查成本远高于此处一层代理）。
  const proxy = new Proxy(stub as unknown as Record<string | symbol, unknown>, {
    get(target, key) {
      if (typeof key !== "string") return undefined;
      if (key in target) return target[key];
      if (key in explicit) return explicit[key];
      if (key in props) return props[key];
      return (...args: unknown[]) => rec(key, args);
    },
    set(target, key, value) {
      if (typeof key === "string") props[key] = value;
      return true;
    },
    has: () => true,
  });

  return proxy as unknown as StubCtx;
}

/* ===== 环境装配 ===== */

export interface ShotEnv {
  /** 所有被创建过的 canvas 的桩 context，按 getContext 首次调用顺序 */
  ctxs: StubCtx[];
  /** invoke 调用记录 */
  invokeCalls: { cmd: string; args: unknown }[];
  /** 覆盖某命令的返回（可在用例中途改；返回值会被 Promise.resolve 包一层） */
  setCommand(cmd: string, impl: (args: any) => unknown): void;
  /** 让某命令 reject */
  failCommand(cmd: string, err: unknown): void;
  /** 某命令被调用次数 */
  countInvoke(cmd: string): number;
  /** 取最后一次调用某命令的参数 */
  lastArgs(cmd: string): unknown;
  /** 已注册的 listen 事件名 → 回调，用来在测试里主动派发后端事件 */
  emitBackend(event: string, payload: unknown): Promise<void>;
}

/** 默认命令表：够让组件走完"启动 → 选区态"这条主路 */
function defaultCommands(): Record<string, (args: any) => unknown> {
  return {
    // 返回 null → 不进贴图编辑模式，走普通截屏
    take_pending_shot_edit: () => null,
    // 直接给结果 → 跳过 700ms 轮询等待（PENDING_WAIT_MS），测试不必用假定时器
    take_pending_shot_capture: () => screenInfo(),
    capture_screen: () => screenInfo(),
    enum_window_rects: () => [],
    virtual_screen_size: () => [1920, 1080],
    snap_window_at: () => null,
    enum_controls: () => null,
    save_screenshot_image: () => "C:/tmp/shot.png",
    get_image_data_url: () => "data:image/png;base64,TEST",
    ocr_image: () => ({ lines: [], full_text: "" }),
    get_scroll_range: () => null,
    get_scroll_bottom: () => null,
    // AI / 动作链列表必须给数组：面板渲染时直接读 .length / .map，
    // 返回 undefined 会在打开面板那一刻抛 TypeError（不是"面板空着"而是整个崩）。
    ai_list_actions: () => [
      {
        id: "explain",
        label: "解释",
        description: "解释这段文字",
        icon: "sparkles",
        maxTokens: 1000,
        options: [],
        contentTypes: [],
      },
    ],
    chain_list: () => [],
  };
}

/**
 * 在 beforeEach 里调用：装三处桩 + 重置 invoke/listen + 清 localStorage + 钉死 AI 状态。
 *
 * 返回的 env 贯穿整个用例。**必须配 afterEach(cleanupShotEnv)**，否则 canvas/Image
 * 的原型改动会漏到别的测试文件。
 */
export function setupShotEnv(opts: { aiOn?: boolean; imageSize?: [number, number] } = {}): ShotEnv {
  // 重复安装守卫：saved* 是模块级的，第二次安装会把**桩自己**当成原始值存进去，
  // 之后 cleanupShotEnv 就永远还不回真实实现了 —— 污染会漏到同进程的其他测试文件。
  // 少写一次 afterEach 就会踩到，所以这里直接判死。
  if (installed) {
    throw new Error("setupShotEnv 重复调用：上一次没有配对 cleanupShotEnv（检查 afterEach）");
  }
  installed = true;

  const ctxs: StubCtx[] = [];
  const invokeCalls: { cmd: string; args: unknown }[] = [];
  const commands = defaultCommands();
  const failures = new Map<string, unknown>();
  const listeners = new Map<string, ((e: { payload: unknown }) => void)[]>();

  probePixel = [0x12, 0x34, 0x56, 255];

  /* ① getContext */
  const ctxCache = new WeakMap<HTMLCanvasElement, StubCtx>();
  savedGetContext = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = function (this: HTMLCanvasElement, kind: string) {
    if (kind !== "2d") return null;
    let c = ctxCache.get(this);
    if (!c) {
      c = makeStubCtx(this);
      ctxCache.set(this, c);
      ctxs.push(c);
    }
    return c as unknown as CanvasRenderingContext2D;
  } as typeof HTMLCanvasElement.prototype.getContext;

  /* ② toBlob（jsdom 未实现）。给一个非空 Blob，FileReader.readAsDataURL 是 jsdom 自带的。 */
  savedToBlob = (HTMLCanvasElement.prototype as { toBlob?: unknown }).toBlob;
  (HTMLCanvasElement.prototype as unknown as { toBlob: unknown }).toBlob = function (
    cb: (b: Blob | null) => void,
    type?: string,
  ) {
    cb(new Blob([new Uint8Array([1, 2, 3, 4])], { type: type || "image/png" }));
  };
  savedToDataURL = HTMLCanvasElement.prototype.toDataURL;
  HTMLCanvasElement.prototype.toDataURL = function () {
    return "data:image/png;base64,STUB";
  } as typeof HTMLCanvasElement.prototype.toDataURL;

  /* ③ Image：src 赋值后在微任务里触发 onload，并给出 natural 尺寸 */
  const [iw, ih] = opts.imageSize ?? [1920, 1080];
  savedImage = globalThis.Image;
  class StubImage {
    onload: (() => void) | null = null;
    onerror: ((e?: unknown) => void) | null = null;
    naturalWidth = iw;
    naturalHeight = ih;
    width = iw;
    height = ih;
    crossOrigin: string | null = null;
    decoding = "auto";
    #src = "";
    get src(): string {
      return this.#src;
    }
    set src(v: string) {
      this.#src = v;
      // 空串/失败标记走 onerror，用来测"底图加载失败不静默"
      queueMicrotask(() => {
        if (!v || v.includes("FAIL")) this.onerror?.(new Error("stub image load failed"));
        else this.onload?.();
      });
    }
  }
  globalThis.Image = StubImage as unknown as typeof Image;

  /* ④ ResizeObserver（jsdom 未实现）。进标注态时 ScreenshotOverlay:1354 会实测工具栏尺寸，
        不桩则整条标注路径抛 ReferenceError。
        空实现是**忠实**的：那个回调第一件事就是 `if (r.width <= 0) return`，
        而 jsdom 无布局、getBoundingClientRect() 恒为 0，真触发也什么都不会改。 */
  savedResizeObserver = (globalThis as { ResizeObserver?: unknown }).ResizeObserver;
  class StubResizeObserver {
    observe(): void {}
    unobserve(): void {}
    disconnect(): void {}
  }
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = StubResizeObserver;

  /* invoke 分发 */
  vi.mocked(invoke).mockReset();
  vi.mocked(invoke).mockImplementation(((cmd: string, args: unknown) => {
    invokeCalls.push({ cmd, args });
    if (failures.has(cmd)) return Promise.reject(failures.get(cmd));
    const impl = commands[cmd];
    if (!impl) return Promise.resolve(undefined);
    try {
      return Promise.resolve(impl(args));
    } catch (e) {
      return Promise.reject(e);
    }
  }) as unknown as typeof invoke);

  /* listen：把回调收下来，供测试主动派发后端事件 */
  vi.mocked(listen).mockReset();
  vi.mocked(listen).mockImplementation((async (event: string, cb: (e: { payload: unknown }) => void) => {
    const arr = listeners.get(event) ?? [];
    arr.push(cb);
    listeners.set(event, arr);
    return () => {
      const cur = listeners.get(event) ?? [];
      listeners.set(
        event,
        cur.filter((f) => f !== cb),
      );
    };
  }) as unknown as typeof listen);

  vi.mocked(emit).mockReset();
  vi.mocked(emit).mockResolvedValue(undefined);

  localStorage.clear();
  // 钉死 AI 判定：setAiAvailabilityForTest 会同时把 loadedAt 设成现在，
  // 于是 useAiStatus 里的 ensureAiAvailabilityLoaded 直接早返回，不会去问后端把它改回来。
  setAiAvailabilityForTest(opts.aiOn ? "on" : "off");

  return {
    ctxs,
    invokeCalls,
    setCommand: (cmd, impl) => {
      commands[cmd] = impl;
      failures.delete(cmd);
    },
    failCommand: (cmd, err) => {
      failures.set(cmd, err);
    },
    countInvoke: (cmd) => invokeCalls.filter((c) => c.cmd === cmd).length,
    lastArgs: (cmd) => {
      // 不用 .at(-1)：项目的 tsconfig lib 目标低于 es2022，没有这个方法
      const hits = invokeCalls.filter((c) => c.cmd === cmd);
      return hits.length > 0 ? hits[hits.length - 1].args : undefined;
    },
    emitBackend: async (event, payload) => {
      const arr = listeners.get(event) ?? [];
      await act(async () => {
        arr.forEach((cb) => cb({ payload }));
        await Promise.resolve();
      });
    },
  };
}

let savedGetContext: typeof HTMLCanvasElement.prototype.getContext | undefined;
let savedToBlob: unknown;
let savedToDataURL: typeof HTMLCanvasElement.prototype.toDataURL | undefined;
let savedImage: typeof Image | undefined;
let savedResizeObserver: unknown;
/** 桩是否已装（配合 setupShotEnv 的重复安装守卫） */
let installed = false;

/** 在 afterEach 里调用：还原原型改动。不还原会污染同一进程内的其他测试文件。 */
export function cleanupShotEnv(): void {
  if (savedGetContext) HTMLCanvasElement.prototype.getContext = savedGetContext;
  if (savedToDataURL) HTMLCanvasElement.prototype.toDataURL = savedToDataURL;
  (HTMLCanvasElement.prototype as unknown as { toBlob: unknown }).toBlob = savedToBlob;
  if (savedImage) globalThis.Image = savedImage;
  (globalThis as { ResizeObserver?: unknown }).ResizeObserver = savedResizeObserver;
  savedGetContext = undefined;
  savedToDataURL = undefined;
  savedToBlob = undefined;
  savedImage = undefined;
  savedResizeObserver = undefined;
  installed = false;
  localStorage.clear();
}

/* ===== 渲染与推进 ===== */

/**
 * 把挂起的微任务与 rAF 推完。
 *
 * 启动链是 take_pending_shot_edit → take_pending_shot_capture → applyScreen
 * → enum_window_rects → 底图 loadImage，横跨好几个 await，一次 flush 不够。
 */
export async function flush(times = 4): Promise<void> {
  for (let i = 0; i < times; i++) {
    await act(async () => {
      await Promise.resolve();
      await new Promise<void>((r) => setTimeout(r, 0));
    });
  }
}

/** 渲染 overlay 并等启动链落地（默认命令表下会停在 select 态） */
export async function renderOverlay(): Promise<RenderResult> {
  const r = render(<ScreenshotOverlay />);
  await flush();
  return r;
}

/* ===== 查询助手（组件里没有 data-testid，一律按 class / 文本定位） ===== */

export const q = (sel: string): HTMLElement | null => document.querySelector<HTMLElement>(sel);
export const qq = (sel: string): HTMLElement[] =>
  Array.from(document.querySelectorAll<HTMLElement>(sel));

/** 根容器。它一定存在（含 !screen 的载入态），可用来判断组件有没有挂上 */
export function shotRoot(): HTMLElement {
  const el = q(".shot-root");
  if (!el) throw new Error("shot-root 不存在：组件没渲染出来");
  return el;
}

/** 标注工具栏（annotate 态才有）。用它判断是否已进标注态。 */
export function toolbar(): HTMLElement | null {
  return q(".annot-toolbar");
}

/** 属性栏（选了需要颜色/粗细/模式的工具才出现） */
export function attrBar(): HTMLElement | null {
  return q(".attr-bar");
}

/**
 * 拖选一块选区并进标注态 —— 多数标注类用例的第一步。
 *
 * 默认矩形刻意避开屏幕边缘与中心线（1920×1080 的中线是 960/540），
 * 免得 applyMagnet 的 8px 磁吸把几何吸走、让断言里的坐标对不上。
 */
export async function enterAnnotate(
  rect: { x: number; y: number; w: number; h: number } = { x: 200, y: 150, w: 600, h: 400 },
): Promise<void> {
  const el = shotRoot();
  fireEvent.mouseDown(el, { clientX: rect.x, clientY: rect.y });
  fireEvent.mouseMove(el, { clientX: rect.x + rect.w, clientY: rect.y + rect.h });
  fireEvent.mouseUp(el);
  await flush();
  if (!toolbar()) throw new Error("没能进入标注态");
}

/** 点主工具栏上的某把工具（按标签文字，如「马赛克」「文字」） */
export function clickTool(label: string): void {
  const btn = qq(".annot-toolbar .tool").find((b) => b.textContent?.includes(label));
  if (!btn) throw new Error(`工具栏没有「${label}」`);
  fireEvent.click(btn);
}

/** 点属性栏里的文字分段（模式 / 粗细 / 强度档位…） */
export function clickAttr(label: string): void {
  const el = qq(".attr-bar .wpick").find((b) => b.textContent?.trim() === label);
  if (!el) throw new Error(`属性栏没有「${label}」`);
  fireEvent.click(el);
}

/** 撤销按钮当前可用吗（栈空时带 disabled 类） */
export function canUndo(): boolean {
  const btn = q(".annot-toolbar .tb-undo");
  if (!btn) throw new Error("撤销按钮不存在");
  return !btn.className.includes("disabled");
}

/** 点撤销 */
export function clickUndo(): void {
  const btn = q(".annot-toolbar .tb-undo");
  if (!btn) throw new Error("撤销按钮不存在");
  fireEvent.click(btn);
}
