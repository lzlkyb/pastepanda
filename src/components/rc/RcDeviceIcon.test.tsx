import { RcDeviceMeta } from "./RcDeviceMeta";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { rcDeviceKind } from "@/lib/utils";
import { RcDeviceIcon } from "./RcDeviceIcon";

describe("device platform presentation", () => {
  it("keeps the device type visible and does not invent missing platform data", () => {
    const { rerender } = render(<RcDeviceMeta os="iPadOS" />);
    expect(screen.getByText("平板")).toBeTruthy();
    rerender(<RcDeviceMeta os="" />);
    expect(screen.getByText("设备")).toBeTruthy();
    expect(screen.getByText(/类型待识别/)).toBeTruthy();
    expect(screen.queryByText("电脑")).toBeNull();
  });
  it.each([
    ["Android 15", "phone"], ["iOS", "phone"], ["iPhone", "phone"],
    ["HarmonyOS", "phone"], ["iPadOS", "tablet"], ["Android tablet", "tablet"],
    ["Windows 11", "computer"], ["macOS", "computer"], ["Linux", "computer"],
    ["", "unknown"], [undefined, "unknown"], ["future platform", "unknown"],
  ] as const)("classifies %s as %s", (os, kind) => {
    expect(rcDeviceKind(os)).toBe(kind);
  });

  it.each([
    ["Android", "手机", "phone"], ["Windows 11", "电脑", "computer"],
    ["iPadOS", "平板", "tablet"], ["", "设备类型尚未获取", "unknown"],
  ])("exposes the correct accessible icon for %s", (os, label, kind) => {
    render(<RcDeviceIcon os={os} />);
    expect(screen.getByRole("img", { name: label }).getAttribute("data-device-kind")).toBe(kind);
  });
});
