import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { invoke } from "@tauri-apps/api/core";
import { useAppStore, DEFAULT_CONFIG } from "@/stores/appStore";
import { useSettingsSave } from "@/hooks/useSettingsSave";
import { WindowBehaviorRows } from "./WindowBehaviorRows";

const { toast, setAlwaysOnTop } = vi.hoisted(() => ({ toast: vi.fn(), setAlwaysOnTop: vi.fn() }));
vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast }) }));
vi.mock("@tauri-apps/api/window", () => ({ getCurrentWindow: () => ({ setAlwaysOnTop }) }));
vi.mock("../NoteTemplateRows", () => ({ NoteTemplateRows: () => null }));
vi.mock("../KbAutoDepositRows", () => ({ KbAutoDepositRows: () => null }));
vi.mock("@/components/HelpTooltip", () => ({ HelpTooltip: () => null }));
vi.mock("../ToggleRow", () => ({
  SettingTile: () => null,
  ToggleRow: ({ label, onChange }: { label: string; onChange: (value: boolean) => void }) => <button onClick={() => onChange(true)}>{label}</button>,
}));
function Harness() {
  const config = useAppStore(s => s.config);
  const { updateAndSave } = useSettingsSave();
  return <WindowBehaviorRows config={config} updateAndSave={updateAndSave} />;
}
beforeEach(() => {
  useAppStore.getState().updateConfig({ ...DEFAULT_CONFIG, auto_startup: false, always_on_top: false });
  toast.mockClear();
  setAlwaysOnTop.mockReset().mockResolvedValue(undefined);
  vi.mocked(invoke).mockReset().mockImplementation(command => Promise.resolve(command === "get_startup" ? false : undefined));
});
afterEach(cleanup);
it("startup service failure restores the saved toggle", async () => {
  vi.mocked(invoke).mockImplementation(command => command === "set_startup" ? Promise.reject(new Error("registry denied")) : Promise.resolve(command === "get_startup" ? false : undefined));
  render(<Harness />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "开机自启" })); });
  expect(useAppStore.getState().config.auto_startup).toBe(false);
});
it("window operation failure restores the saved toggle", async () => {
  setAlwaysOnTop.mockRejectedValueOnce(new Error("window denied"));
  render(<Harness />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "窗口置顶" })); });
  expect(useAppStore.getState().config.always_on_top).toBe(false);
});
it("save failure never invokes the startup service", async () => {
  vi.mocked(invoke).mockImplementation(command => command === "save_config" ? Promise.reject(new Error("disk denied")) : Promise.resolve(command === "get_startup" ? false : undefined));
  render(<Harness />);
  await act(async () => { fireEvent.click(screen.getByRole("button", { name: "开机自启" })); });
  expect(vi.mocked(invoke).mock.calls.some(([command]) => command === "set_startup")).toBe(false);
});
