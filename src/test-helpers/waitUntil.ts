// 假计时器文件里的「等数据落地」。
//
// 为什么不用 @testing-library 的 waitFor：它在检测到假计时器时会改走「推进 jest 时钟」那条
// 分支（本仓用的是 vitest，没有全局 `jest`），实测在「vi.useFakeTimers() + 取数落在真实宏任务」
// 的组合下判据永不复查，直接把用例拖到 testTimeout。而慢取数注入（PASTEPANDA_SLOW_MOCK=1，
// 见 src/test-setup.slow-mock.ts）正是把每个 mock 的异步返回推到**真实**宏任务，
// 所以挂了假计时器的文件只能按这个节奏等。
//
// 用法约束：`probe` 必须是**只有真数据才成立**的判据（渲染出来的文字、store 里回滚后的值），
// 不许写成「某个 mock 被调用过」或「初值等于目标值」——那类判据在首帧就成立，等于没等
// （Issue #3 拦的就是它）。到点不成立就带着 label 抛错，不许静默放行。
//
// realSetTimeout 在**模块装载时**取，早于任何 `vi.useFakeTimers()`：假计时器会替换
// globalThis.setTimeout，之后再取就只会拿到那个永不推进的假钟。
import { act } from "@testing-library/react";

const realSetTimeout = globalThis.setTimeout;

const DEFAULT_MAX_TICKS = 200;

const oneRealTick = () => new Promise<void>((resolve) => realSetTimeout(resolve, 0));

export async function waitUntilContent(probe: () => boolean, label: string, maxTicks = DEFAULT_MAX_TICKS): Promise<void> {
  for (let tick = 0; tick < maxTicks; tick++) {
    if (probe()) return;
    await oneRealTick();
  }
  throw new Error(`等不到「${label}」：${maxTicks} 拍真实宏任务后判据仍不成立（取数没落地，不是断言写错）`);
}

/**
 * 判据读的是**渲染出来的 DOM** 时用这一条。
 *
 * 与 waitUntilContent 的差别只有一件：每一拍都包在 `act` 里，于是取数落地触发的
 * setState 会在下一拍复查之前真的提交到 DOM（裸 `await` 时 React 的提交排在另一个
 * 宏任务上，判据可能晚一拍才成立——不致错，但白等）。
 * 只有 jsdom 环境的测试文件该引它；node 环境的纯逻辑用例用 waitUntilContent。
 */
export async function waitUntilRenderedContent(probe: () => boolean, label: string, maxTicks = DEFAULT_MAX_TICKS): Promise<void> {
  for (let tick = 0; tick < maxTicks; tick++) {
    if (probe()) return;
    await act(async () => {
      await oneRealTick();
    });
  }
  throw new Error(`等不到「${label}」：${maxTicks} 拍 act 内的真实宏任务后判据仍不成立（取数没落地，不是断言写错）`);
}
