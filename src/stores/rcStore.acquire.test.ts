/**
 * rcStore.acquire 启动拉取设备列表的守卫单测（2026-10-01 真机联调回归钉）。
 *
 * 故障原貌：轮询引擎每个 tick 只刷 rc_status，设备列表只有「配对成功 / 手动
 * 重试」这些动作才拉——重启后没人去读 rc_devices 表，手机端列表永远空着、
 * 界面退回配对页（数据其实一直在库里）。
 * 钉住：首个订阅者挂载必须同时拉 status **和** targets；第二个订阅者不重复拉。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { useRcStore } from "./rcStore";
import { rcStatus, rcTargets } from "@/lib/api/rc";

vi.mock("@/lib/api/rc", async (importOriginal) => ({
  ...(await importOriginal<Record<string, unknown>>()),
  rcStatus: vi.fn(async () => ({ enabled: true, running: true })),
  rcTargets: vi.fn(async () => [{ node_id: "pc-1", name: "台式机" }]),
}));

const status = vi.mocked(rcStatus);
const targets = vi.mocked(rcTargets);

beforeEach(() => {
  status.mockClear();
  targets.mockClear();
  // 用例间把订阅计数归零，保证每个用例都从「首个订阅者」开始
  const st = useRcStore.getState();
  while (st.subscribers > 0) st.release();
  vi.clearAllTimers?.();
});

describe("acquire 启动拉取", () => {
  it("首个订阅者：status 与 targets 都拉（重启后列表不再空）", () => {
    useRcStore.getState().acquire();
    expect(status).toHaveBeenCalled();
    expect(targets).toHaveBeenCalledTimes(1);
    useRcStore.getState().release();
  });

  it("第二个订阅者不重复触发启动拉取", () => {
    useRcStore.getState().acquire();
    useRcStore.getState().acquire();
    expect(targets).toHaveBeenCalledTimes(1);
    useRcStore.getState().release();
    useRcStore.getState().release();
  });
});
