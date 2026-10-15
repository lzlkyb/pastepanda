import { vi } from "vitest";

// 「慢取数」注入：把 mock 的异步返回值从微任务推迟到**真实宏任务**落地。
// 目的不是测速度，而是把「等永真条件」的等待写法变成必然判红：
// waitFor/findBy* 的判据如果在首帧就成立（初值即目标值、或只等 invoke 被调用过），
// 数据还没进 DOM 时它已经绿了——快机器碰巧过、CI 随机挂（见 Issue #2/#3）。
//
// 只在 PASTEPANDA_SLOW_MOCK=1 时装载（见 vitest.config.ts 的 SETUP_SLOW），
// 常规跑与 CI 不受影响。
//
// captured before any file calls vi.useFakeTimers(): 真实计时器引用必须留在闭包里，
// 否则假计时器装好后 setTimeout 被替换，被推迟的取数永远不落地，表现成整批超时——
// 那是工具自身的假红，不是被测代码的问题。
const realSetTimeout = globalThis.setTimeout;

// 已经推迟过一次的 promise 记在这里。没有它，`mockResolvedValue(x)` 会被推**两**层宏任务
// （override 先 deferToMacrotask，vitest 内部 `() => Promise.resolve(value)` 的返回值
// 又被 deferResult 推一次），而 `vi.fn(async () => x)` 只有一层——同一份代码
// 按调用 mock 的 API 不同而有不同延迟，修用例时就得猜要冲刷几轮，工具口径应当与 API 无关。
const alreadyDeferred = new WeakSet<object>();

// 同一个 mock 只装饰一次。注入模式下 `vi.fn()` 出厂就带装饰，测试文件里再手动
// `decorateMock(vi.fn())`（机制守卫 slowFetchInjection.test.tsx 就是这么写的）会把方法
// 再套一层，延迟档随之翻倍——延迟档必须是常数，否则「冲刷几轮才落地」无从收敛。
const decoratedMocks = new WeakSet<object>();

export function deferToMacrotask<T>(value: T): Promise<T> {
  const deferred = new Promise<T>((resolve) => {
    realSetTimeout(() => resolve(value), 0);
  });
  alreadyDeferred.add(deferred);
  return deferred;
}

type AnyFn = (...args: unknown[]) => unknown;

function isThenable(value: unknown): value is PromiseLike<unknown> {
  return !!value && typeof (value as PromiseLike<unknown>).then === "function";
}

function deferResult(result: unknown): unknown {
  if (!isThenable(result)) return result;
  // Promise.resolve(p) 对同源原生 promise 返回它自己，所以这里能认出已推迟过的那一个。
  if (alreadyDeferred.has(result as object)) return result;
  return Promise.resolve(result).then((value) => deferToMacrotask(value));
}

function deferImplementation(impl: unknown): unknown {
  if (typeof impl !== "function") return impl;
  const wrapped = function (this: unknown, ...args: unknown[]) {
    return deferResult((impl as AnyFn).apply(this, args));
  };
  // mockResolvedValue 等 API 内部走 new.target 判构造函数误用，丢掉元信息会让报错文案变味。
  Object.defineProperty(wrapped, "length", { value: (impl as AnyFn).length });
  Object.defineProperty(wrapped, "name", { value: (impl as AnyFn).name });
  return wrapped;
}

// M 放宽到 object：调用方传的是 vitest 的 Mock（函数对象），约束成 Record 会让
// Mock<Procedure> 不可赋（TS2345）；属性读写全部走下方可写视图，不改运行时行为。
export function decorateMock<M extends object>(mock: M): M {
  if (decoratedMocks.has(mock)) return mock;
  decoratedMocks.add(mock);
  // 泛型 M 在 TS 眼里只可索引读取（TS2862），这里要的是「换掉方法」，所以走一个明确的
  // 可写视图；写回的还是同一个对象，运行时没有差别。
  const methods = mock as unknown as Record<string, unknown>;
  for (const key of ["mockImplementation", "mockImplementationOnce"] as const) {
    const original = methods[key];
    if (typeof original !== "function") continue;
    methods[key] = function (this: M, impl: unknown) {
      return original.call(this, deferImplementation(impl));
    };
  }
  // 传一个「稍后才落地」的 promise 进去：Promise 链会摊平，于是 mockResolvedValue(x)
  // 的调用方拿到同样的 x，但要过宏任务才 resolve——不必重造 vitest 的实现细节。
  // 只推迟**一层**：vitest 内部 `() => Promise.resolve(value)` 的返回值已由 deferResult
  // 里的 alreadyDeferred 认出，不会再叠第二次（延迟档必须是常数）。
  for (const key of ["mockResolvedValue", "mockResolvedValueOnce"] as const) {
    const original = methods[key];
    if (typeof original !== "function") continue;
    methods[key] = function (this: M, value: unknown) {
      return original.call(this, deferToMacrotask(value));
    };
  }
  return mock;
}

// vi.fn(impl) 把实现存进构造路径、不经过 mockImplementation ⇒ 光装饰方法拦不到它。
// 用同一个实现经装饰后的 mockImplementation 重设一次，测试里最常见的
// `vi.fn(async () => data)` 才会真的被推迟。
export function decorateCreatedMock<M extends object>(mock: M, impl?: unknown): M {
  decorateMock(mock);
  if (typeof impl === "function") {
    (mock as unknown as { mockImplementation: (i: unknown) => unknown }).mockImplementation(impl);
  }
  return mock;
}

export function installSlowMockInjection(): void {
  const originalFn = vi.fn;
  const originalSpyOn = vi.spyOn;
  // vi 的属性是只读视图，这里走可写视图换掉实现（运行时同一个对象）。
  const viMutable = vi as unknown as Record<string, unknown>;
  viMutable.fn = (...args: Parameters<typeof originalFn>) => decorateCreatedMock(originalFn(...args), args[0]);
  viMutable.spyOn = (...args: Parameters<typeof originalSpyOn>) => decorateMock(originalSpyOn(...args));
}

if (process.env.PASTEPANDA_SLOW_MOCK === "1") {
  installSlowMockInjection();
}
