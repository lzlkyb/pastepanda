import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { useEffect, useState } from "react";
import { decorateCreatedMock, decorateMock } from "../test-setup.slow-mock";

// Issue #3 的机制守卫：钉住「慢取数注入」真的会把取数推到宏任务，并且
// 「首帧即成立的判据 + 随后直接读内容」这种写法在注入下**必然判红**。
// 判红方向自查（同 [[feedback-falsify-your-guards]]，2026-10-11 四条全部实测，
// 每条改完都 `cmp` 验字节还原）：
// ① 把 test-setup.slow-mock.ts 里 deferToMacrotask 的 realSetTimeout 换成 Promise.resolve
//    ⇒ 6 红 / 1 绿（只有「同步实现不被拖慢」该绿）；
// ② 把 decorateMock 变成空实现 ⇒ 同样 6 红 / 1 绿；
// ③ 删掉 deferResult 里 `alreadyDeferred.has(...)` 那条短路 ⇒ 只有「延迟档 = 一个真实宏
//    任务」红（mockResolvedValue 被推两层），其余 6 条照绿；
// ④ 注释掉文件末尾的 `installSlowMockInjection()` ⇒ 只有下面「注入档按环境变量装载」红
//    ——其余各条都显式调 decorateMock，挂载点断了它们照样绿，那就等于验收在常规档上宣布成功。
// 守卫不咬人的注入等于没扫描。

afterEach(() => cleanup());

const SLOW = process.env.PASTEPANDA_SLOW_MOCK === "1";

/**
 * 这条钉的是「这一轮跑的到底是哪一档」：上面几条都显式调 `decorateMock`，
 * 就算 `vitest.config.ts` 的挂载点被人摘掉（环境变量没生效、setupFiles 被删），
 * 它们照样全绿，而「注入档 0 失败」的验收就变成了在常规档上宣布成功。
 * 所以这里断言的是**未经手工装饰**的 `vi.fn(async …)` 的落地时刻，两种模式各有一种正确形状。
 */
describe("注入档按环境变量装载", () => {
  it(SLOW ? "注入档：ambient vi.fn(async) 的返回值不在微任务里落地" : "常规档：没装注入，ambient vi.fn(async) 在微任务就落地", async () => {
    const load = vi.fn(async () => "标题");
    let settled = false;
    const pending = load().then(() => {
      settled = true;
    });
    await flushMicrotasks();
    expect(settled, SLOW ? "PASTEPANDA_SLOW_MOCK=1 却没推迟=挂载点断了，扫描与验收都是空转" : "默认档被拖慢=常规跑和 CI 的行为变了").toBe(
      !SLOW,
    );
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    await pending;
    expect(settled, "再一拍之后仍未落地=延迟档不止一个宏任务").toBe(true);
  });
});

function AsyncCard({ load }: { load: () => Promise<string> }) {
  const [text, setText] = useState("加载中");
  useEffect(() => {
    let alive = true;
    load().then((value) => {
      if (alive) setText(value);
    });
    return () => {
      alive = false;
    };
  }, [load]);
  return <div data-testid="card">{text}</div>;
}

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

describe("慢取数注入本身", () => {
  it("装饰后的 mockResolvedValue 不在微任务里落地", async () => {
    // 顺序有意义：decorate 换的是方法实现，先 .mockResolvedValue 再装饰等于没装饰。
    const load = decorateMock(vi.fn());
    load.mockResolvedValue("标题");
    let settled = false;
    const pending = load().then((value: string) => {
      settled = true;
      return value;
    });

    await flushMicrotasks();
    expect(settled, "微任务就落地=注入退化成没注入，永真等待照样碰巧过").toBe(false);

    expect(await pending).toBe("标题");
    expect(settled).toBe(true);
  });

  it("装饰后的 async 实现（mockImplementation(async () => x)）同样被推迟一个宏任务", async () => {
    const load = decorateMock(vi.fn());
    load.mockImplementation(async () => "标题");
    let settled = false;
    const pending = load().then((value: unknown) => {
      settled = true;
      return value;
    });

    await flushMicrotasks();
    expect(settled, "async 实现没被装饰=测试里最常见的写法仍在漏网").toBe(false);
    expect(await pending).toBe("标题");
  });

  it("构造时传实现的写法（vi.fn(async () => x)）同样被推迟", async () => {
    // 这条钉的是 decorateCreatedMock：vi.fn(impl) 的实现走构造路径，
    // 只装饰 mockImplementation 系列方法拦不到它。
    const load = decorateCreatedMock(vi.fn(), async () => "标题");
    let settled = false;
    const pending = load().then((value: unknown) => {
      settled = true;
      return value;
    });

    await flushMicrotasks();
    expect(settled, "构造路径的实现没被推迟=vi.fn(async () => data) 全在漏网").toBe(false);
    expect(await pending).toBe("标题");
  });

  it("同步实现不被拖慢（纯函数守卫不该因此付宏任务）", async () => {
    const read = decorateMock(vi.fn());
    read.mockImplementation(() => "同步值");
    expect(read()).toBe("同步值");
  });

  it("🔴 延迟档 = 一个真实宏任务，且与「怎么设值」无关", async () => {
    // 为什么钉这条：修用例时要知道「冲刷几轮才落地」，轮数必须是常数。
    // `mockResolvedValue` 曾被推**两**层宏任务（override 先 deferToMacrotask，vitest 内部
    // `() => Promise.resolve(value)` 的返回值又被 deferResult 推一次），而
    // `vi.fn(async () => x)` 只有一层 ⇒ 同一个组件换个设值写法就要多冲一拍。
    // 删掉 deferResult 里 `alreadyDeferred.has(...)` 那条短路，本用例第一条就红。
    const byResolvedValue = decorateMock(vi.fn());
    byResolvedValue.mockResolvedValue("标题");
    const byImplementation = decorateMock(vi.fn());
    byImplementation.mockImplementation(async () => "标题");
    const byConstructor = decorateCreatedMock(vi.fn(), async () => "标题");

    const settled = { resolved: false, impl: false, ctor: false };
    const pending = [
      byResolvedValue().then(() => {
        settled.resolved = true;
      }),
      byImplementation().then(() => {
        settled.impl = true;
      }),
      byConstructor().then(() => {
        settled.ctor = true;
      }),
    ];

    // 先把微任务排干净（构造路径的延迟计时器要靠这一次才挂上），再走**一个**真实宏任务。
    await flushMicrotasks();
    expect(settled, "微任务里就落地=这一条没在量宏任务").toEqual({ resolved: false, impl: false, ctor: false });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(settled, "一拍之后仍没落地=延迟档不止一个宏任务，修法无法收敛").toEqual({
      resolved: true,
      impl: true,
      ctor: true,
    });
    await Promise.all(pending);
  });
});

describe("永真等待在慢取数下必须判红", () => {
  it("首帧即成立的判据 + 随后直接读内容 → 读到空壳", async () => {
    const load = decorateMock(vi.fn());
    load.mockResolvedValue("真实标题");
    // 组件拿到的取数包一层，记录「数据真的落地」的时刻：这条断言不经过 act，
    // 所以它量的是 promise 本身何时 resolve，而不是 React 何时重渲染。
    let landed = false;
    const trackedLoad = async () => {
      const value = await load();
      landed = true;
      return value;
    };
    const { container } = render(<AsyncCard load={trackedLoad as unknown as () => Promise<string>} />);

    // 注入生效的证明：微任务排空后取数仍未落地。把 deferToMacrotask 的 setTimeout 换成
    // Promise.resolve，这一句就红 ⇒ 本用例不是「反正首帧都读不到」的空转。
    await flushMicrotasks();
    expect(landed, "微任务里数据就到了=注入没生效，本守卫失去意义").toBe(false);

    // 反例写法的落点：判据「初值是加载中」在首帧就成立，这种等待返回时内容还是空壳。
    expect(container.textContent).toBe("加载中");
    expect(screen.queryByText("真实标题")).toBeNull();

    // 正例写法：等内容判据成立再读（这也是 Issue #3 要求收敛到的形态）。
    expect(await screen.findByText("真实标题")).toBeTruthy();
  });
});
