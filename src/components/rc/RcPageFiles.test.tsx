import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { UseRc } from "@/hooks/useRc";
import type { RcTargetDevice } from "@/lib/api/rc";
import { RcPageFiles } from "./RcPageFiles";

vi.mock("./RcFilePanel", () => ({ RcFilePanel: () => <div>文件操作</div> }));
afterEach(cleanup);

describe("文件页接收规则", () => {
  const target: RcTargetDevice = {
    node_id: "peer-a", name: "设备 A", conn_state: "ready", last_seen: 1,
    denied: false, source: "rc", presence: "live", auto_accept: false,
  };

  it("默认需要本机确认，自动接收开启后显示当前授权且不再承诺每次确认", () => {
    const rc = { targets: [target] } as unknown as UseRc;
    const view = render(<RcPageFiles rc={rc} />);
    expect(screen.getByText(/此设备发来的文件需要你点「接受」/)).toBeTruthy();
    view.rerender(<RcPageFiles rc={{ ...rc, targets: [{ ...target, auto_accept: true }] }} />);
    expect(screen.getByText(/已允许自动接收此设备发来的文件/)).toBeTruthy();
    expect(screen.queryByText(/此设备发来的文件需要你点「接受」/)).toBeNull();
    expect(screen.getByText(/发送文件时，按对方设置确认或自动接收/)).toBeTruthy();
  });
});
