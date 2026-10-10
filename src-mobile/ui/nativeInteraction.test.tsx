import { afterEach, expect, it, vi } from "vitest";
const platform = vi.hoisted(() => ({ tauri: false, invoke: vi.fn().mockResolvedValue(undefined) }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => platform.tauri, invoke: platform.invoke }));
afterEach(() => { platform.tauri = false; vi.restoreAllMocks(); vi.resetModules(); platform.invoke.mockReset().mockResolvedValue(undefined); });
it("浏览器与非Android端不发原生调用", async () => {
  const bridge = await import("./nativeInteraction");
  bridge.configureNativeBack(true); bridge.mobileHaptic("ready");
  await Promise.resolve(); expect(platform.invoke).not.toHaveBeenCalled();
});
it("返回层启停串行，最后的根返回禁用不能被迟到启用覆盖", async () => {
  platform.tauri = true;
  vi.spyOn(navigator, "userAgent", "get").mockReturnValue("Android");
  let finish!: () => void;
  platform.invoke.mockImplementationOnce(() => new Promise<void>(resolve => { finish = resolve; }));
  const bridge = await import("./nativeInteraction");
  bridge.configureNativeBack(true); bridge.configureNativeBack(false);
  await vi.waitFor(() => expect(platform.invoke).toHaveBeenCalledTimes(1));
  finish();
  await vi.waitFor(() => expect(platform.invoke).toHaveBeenCalledTimes(2));
  expect(platform.invoke.mock.calls.map(call => call[1])).toEqual([{ enabled: true }, { enabled: false }]);
});
it("进度钳制，非法事件被忽略，卸载移除监听", async () => {
  const bridge = await import("./nativeInteraction"), receive = vi.fn();
  const stop = bridge.listenNativeBack(receive);
  window.dispatchEvent(new CustomEvent("mobile-native-back", { detail: { phase: "progress", progress: 9, edge: "right" } }));
  expect(receive).toHaveBeenLastCalledWith({ phase: "progress", progress: 1, edge: "right" });
  window.dispatchEvent(new CustomEvent("mobile-native-back", { detail: { phase: "other" } }));
  stop(); window.dispatchEvent(new CustomEvent("mobile-native-back", { detail: { phase: "commit" } }));
  expect(receive).toHaveBeenCalledOnce();
});
