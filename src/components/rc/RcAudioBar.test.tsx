import { render, screen } from "@testing-library/react";
import { type ComponentProps } from "react";
import { expect, it, vi } from "vitest";
import { RcAudioBar } from "./RcAudioBar";
it("shows host audio failures in a view-only session", () => {
  const rc = { status: { peer_audio: { local_mute: false, spk_mute: false, err: "AAC 编码失败" } } } as unknown as ComponentProps<typeof RcAudioBar>["rc"];
  render(<RcAudioBar rc={rc} canControl={false} audioOn={false} onToggleAudio={vi.fn()} onStatus={vi.fn()} />);
  expect(screen.getByRole("alert").textContent).toContain("AAC 编码失败");
  expect(screen.queryByText("对方外放")).toBeNull();
});
