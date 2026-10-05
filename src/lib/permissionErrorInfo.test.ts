import { describe, expect, it } from "vitest";
import { permissionErrorInfo } from "./utils";
import { rcErrorText } from "../../src-mobile/devices/rcErrorText";
import { classifyErr } from "./rcFile";

describe("权限提示按原因分类，不能让用户乱改系统设置", () => {
  it("内部授权先于文件/相机上下文", () => {
    for (const context of ["general", "file-receive", "file-send", "camera"] as const) {
      const info = permissionErrorInfo("plugin:fs|read_file denied. permissions: fs:allow-read-file", context);
      expect(info?.kind).toBe("internal");
      expect(info?.detail).toContain("无需调整手机权限");
    }
    expect(rcErrorText("invoke command permission denied")).toContain("应用内部授权失败");
    expect(permissionErrorInfo("plugin:fs|read_file not allowed")?.kind).toBe("internal");
  });
  it("接收目录拒绝明确指向重置；文件读取失败指向重新选择", () => {
    expect(permissionErrorInfo("Permission denied (os error 13)", "file-receive")?.kind).toBe("file-receive");
    expect(rcErrorText("接收目录 /sample 建不出来：Permission denied (os error 13)")).toContain("重置接收位置");
    expect(permissionErrorInfo("NotAllowedError", "file-send")?.detail).toContain("重新选择文件");
  });
  it("未获相机授权有具体路径；不存在的相机不算权限问题", () => {
    expect(permissionErrorInfo(new DOMException("", "NotAllowedError"), "camera")?.detail).toContain(
      "PastePanda → 权限 → 相机",
    );
    expect(permissionErrorInfo(new DOMException("", "NotFoundError"), "camera")).toBeNull();
  });
  it("文件任务不能把磁盘 Permission denied 误报为对方拒绝", () => {
    expect(classifyErr("接收目录建不出来：Permission denied").title).toContain("接收位置");
    expect(classifyErr("对方拒绝了这次传输").title).toBe("对方拒绝了");
    expect(rcErrorText("对方拒绝了此次请求", "file-receive")).toContain("在电脑端 PastePanda");
  });
  it("未知拒绝不编造权限类型，已有网络错误不受影响", () => {
    expect(permissionErrorInfo("denied")?.kind).toBe("unknown");
    expect(rcErrorText("network timeout")).toContain("网络连接失败");
    expect(permissionErrorInfo("文件不存在")).toBeNull();
  });
});
