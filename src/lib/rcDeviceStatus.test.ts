import { describe, expect, it } from "vitest";
import { rcDeviceStatus } from "@/lib/utils";

describe("rcDeviceStatus", () => {
  it("把短连接结果与历史在线状态分开，失败不宣称对方离线", () => {
    expect(rcDeviceStatus("seen", { state: "reachable", checkedAt: 1000 }, true, 2000).label).toBe("刚刚可连接");
    expect(rcDeviceStatus("live", { state: "unreachable", checkedAt: 1000 }, true, 2000).label).toBe("暂时连不上");
    // U8：「尚未确认」是实现语义，改说用户视角的话
    expect(rcDeviceStatus("seen", undefined, true, 2000).label).toBe("最近在线 · 未实测");
    expect(rcDeviceStatus("live", undefined, true, 2000).label).toBe("局域网在线");
  });

  it("检查过期和本机通道关闭时不再展示刚刚可连接", () => {
    expect(rcDeviceStatus("seen", { state: "reachable", checkedAt: 1000 }, true, 50_000).label).toBe("最近在线 · 未实测");
    expect(rcDeviceStatus("seen", { state: "reachable", checkedAt: 1000 }, false, 2000).label).toBe("状态无法获取 · 通道未启动");
    expect(rcDeviceStatus("seen", undefined, null, 2000).label).toBe("正在获取状态");
  });
});

