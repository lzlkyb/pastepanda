import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, expect, it } from "vitest";
import { REC_QUALITIES } from "@/lib/recQuality";
import { ConfirmBar } from "./RecOverlayParts";
import styles from "./RecOffice.module.css";

/** 帮助浮层恒朝上（bottom: calc(100% + 8px)，约一盒高）：确认条落在贴近屏顶的位置时，
 *  朝上的盒子会整块伸出屏幕上沿被 overflow:hidden 裁掉——必须像画质浮层那样翻到下方。 */
afterEach(() => cleanup());

const noop = () => undefined;
const show = (rect: { x: number; y: number; w: number; h: number }) =>
  render(
    <ConfirmBar
      rect={rect}
      target={{ text: "1920 × 1080", kind: "screen" }}
      screenCssW={1920}
      screenCssH={1080}
      quality={REC_QUALITIES[0]}
      onQuality={noop}
      sysAudio={false}
      micAudio={false}
      onSys={noop}
      onMic={noop}
      settingsOpen={false}
      onToggleSettings={noop}
      helpOpen
      onToggleHelp={noop}
      onRedraw={noop}
      onCancel={noop}
      onStart={noop}
    />,
  );

it("确认条贴屏顶时帮助浮层翻到下方", () => {
  // 选区在屏幕上沿：条挂在选区下方（top ≈ rect.y + rect.h + 14 = 102 < 150）
  show({ x: 100, y: 8, w: 600, h: 80 });
  expect(screen.getByRole("note").classList.contains(styles.helpBoxBelow)).toBe(true);
});

it("确认条在屏幕中部时帮助浮层保持朝上", () => {
  show({ x: 100, y: 400, w: 600, h: 300 });
  expect(screen.getByRole("note").classList.contains(styles.helpBoxBelow)).toBe(false);
});
