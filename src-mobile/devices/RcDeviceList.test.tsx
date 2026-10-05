import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { RcTargetDevice } from "@/lib/api/rc";
import { RcDeviceList } from "./RcDeviceList";

describe("mobile paired devices", () => {
  it("distinguishes phone and computer while keeping the user's alias", () => {
    const targets = [
      { node_id: "phone", name: "Google Pixel 9", display_name: "我的手机", os: "Android" },
      { node_id: "pc", name: "DESKTOP-A", os: "Windows 11" },
    ] as RcTargetDevice[];
    render(<RcDeviceList targets={targets} reachability={{}} channelUp={true} onPick={() => {}} />);
    expect(screen.getByText("我的手机")).toBeTruthy();
    expect(screen.getByText("DESKTOP-A")).toBeTruthy();
    expect(screen.getByRole("img", { name: "手机" })).toBeTruthy();
    expect(screen.getByRole("img", { name: "电脑" })).toBeTruthy();
    expect(screen.getByText("手机")).toBeTruthy();
    expect(screen.getByText("电脑")).toBeTruthy();
    expect(screen.queryByText("新设备")).toBeNull();
  });
});
