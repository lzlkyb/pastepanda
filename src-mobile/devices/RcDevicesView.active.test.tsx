import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import type { UseRc } from "@/hooks/useRc";
import { RcDevicesView } from "./RcDevicesView";

vi.mock("./RcDeviceList", () => ({ RcDeviceList: ({ onPick }: { onPick: (id: string) => void }) => <><p>设备列表</p><button onClick={() => onPick("pc")}>选择测试电脑</button></> }));
vi.mock("../ui/MobileSheet", () => ({ MobileSheet: () => null }));
afterEach(cleanup);

it("保留设备页预览不发探测，进入页面才重新检查", () => {
  const probe = vi.fn().mockResolvedValue(undefined);
  const rc = {
    targets: [{ node_id: "pc" }],
    targetsLoaded: true,
    status: { running: true },
    probeTargets: probe,
  } as unknown as UseRc;
  const view = render(<RcDevicesView rc={rc} session={null} onSendFiles={vi.fn()} active={false} />);
  expect(probe).not.toHaveBeenCalled();
  view.rerender(<RcDevicesView rc={rc} session={null} onSendFiles={vi.fn()} active />);
  expect(probe).toHaveBeenCalledTimes(1);
  view.rerender(<RcDevicesView rc={rc} session={null} onSendFiles={vi.fn()} active={false} />);
  expect(probe).toHaveBeenCalledTimes(1);
  view.rerender(<RcDevicesView rc={rc} session={null} onSendFiles={vi.fn()} active />);
  expect(probe).toHaveBeenCalledTimes(2);
});

it("当前设备操作面板认领错误，切页和卸载均释放", () => {
  const scope = vi.fn();
  const rc = { targets: [{ node_id: "pc" }], targetsLoaded: true, status: { running: true }, probeTargets: vi.fn().mockResolvedValue(undefined) } as unknown as UseRc;
  const props = { rc, session: null, onSendFiles: vi.fn(), onErrorScopeChange: scope };
  const view = render(<RcDevicesView {...props} active />);
  expect(scope).toHaveBeenLastCalledWith(false);
  fireEvent.click(screen.getByRole("button", { name: "选择测试电脑" }));
  expect(scope).toHaveBeenLastCalledWith(true);
  view.rerender(<RcDevicesView {...props} active={false} />);
  expect(scope).toHaveBeenLastCalledWith(false);
  view.rerender(<RcDevicesView {...props} active />);
  expect(scope).toHaveBeenLastCalledWith(true);
  view.unmount();
  expect(scope).toHaveBeenLastCalledWith(false);
});
