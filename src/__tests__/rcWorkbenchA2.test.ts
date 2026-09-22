import { describe, expect, it } from "vitest";
import {
  hidesWorkbenchTitleBar,
  resolveRcA2Selection,
  resolveRcA2Surface,
  type RcA2Page,
} from "@/lib/rcWorkbenchA2";

const targets = [{ node_id: "alpha" }, { node_id: "beta" }];

describe("远程电脑 A2 工作台状态模型", () => {
  it("没有选择时选中第一台设备；原设备消失后也回落到第一台", () => {
    expect(resolveRcA2Selection(targets, null)).toBe("alpha");
    expect(resolveRcA2Selection(targets, "missing")).toBe("alpha");
    expect(resolveRcA2Selection(targets, "beta")).toBe("beta");
  });

  it("没有设备时不制造不存在的选择", () => {
    expect(resolveRcA2Selection([], "missing")).toBeNull();
  });

  it("等待、被控和出站会话优先于之前打开的工具页", () => {
    const pages: RcA2Page[] = ["devices", "files", "history", "settings"];
    for (const page of pages) {
      expect(resolveRcA2Surface("pending", page)).toBe("pending");
      expect(resolveRcA2Surface("inbound", page)).toBe("inbound");
      expect(resolveRcA2Surface("outbound", page)).toBe("session");
    }
  });

  it("空闲时保留用户选择的设备或工具页面", () => {
    expect(resolveRcA2Surface("idle", "devices")).toBe("devices");
    expect(resolveRcA2Surface("idle", "files")).toBe("files");
    expect(resolveRcA2Surface("idle", "history")).toBe("history");
    expect(resolveRcA2Surface("idle", "settings")).toBe("settings");
  });

  it("只有出站会话态收标题栏；等待与被控态要留着（那两态还要用它的按钮）", () => {
    expect(hidesWorkbenchTitleBar("session")).toBe(true);
    for (const surface of ["pending", "inbound", "devices", "files", "history", "settings"] as const) {
      expect(hidesWorkbenchTitleBar(surface)).toBe(false);
    }
  });
});
