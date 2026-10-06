/**
 * rec API 守卫单测：钉住 Tauri IPC 的**传参形状**。
 *
 * 这一类错误 tsc 与运行时都查不出来（后端只回一句 invalid args，用户在界面上
 * 看到失败卡）：2026-10-05 实测抓到 rec_start 把字段平铺直传，而 Tauri 命令
 * `rec_start(req: RecStartReq)` 要求按**形参名** `{ req: {...} }` 包裹——
 * `rename_all = "camelCase"` 只管结构体内部字段，不改变包裹层。
 */
import { beforeEach, describe, expect, it, vi } from "vitest";

const h = vi.hoisted(() => ({ invoke: vi.fn() }));

vi.mock("@tauri-apps/api/core", () => ({ invoke: h.invoke }));

import {
  recCloseWindows,
  recDeleteFile,
  recListFiles,
  recOpenFile,
  recRerecord,
  recStart,
  recStop,
} from "./rec";

beforeEach(() => {
  h.invoke.mockReset().mockResolvedValue(undefined);
});

describe("rec IPC 传参形状", () => {
  it("rec_start 必须按形参名包一层 { req: … }，字段 camelCase", async () => {
    await recStart({
      x: 10,
      y: 20,
      w: 640,
      h: 360,
      quality: "high",
      sysAudio: true,
      micAudio: false,
    });
    expect(h.invoke).toHaveBeenCalledTimes(1);
    expect(h.invoke).toHaveBeenCalledWith("rec_start", {
      req: {
        x: 10,
        y: 20,
        w: 640,
        h: 360,
        quality: "high",
        sysAudio: true,
        micAudio: false,
      },
    });
  });

  it("rec_stop 的形参就是标量 discard，平传不包裹", async () => {
    await recStop(true);
    expect(h.invoke).toHaveBeenCalledWith("rec_stop", { discard: true });
  });

  it("无参命令不夹带多余键", async () => {
    await recCloseWindows();
    expect(h.invoke).toHaveBeenCalledWith("rec_close_windows", undefined);
  });

  it("二期新增：标量 path 参数平传，无参命令不夹带", async () => {
    await recRerecord();
    await recListFiles();
    await recDeleteFile("C:\\v\\PastePanda\\屏幕录制_a.mp4");
    await recOpenFile("C:\\v\\PastePanda\\屏幕录制_a.mp4");
    expect(h.invoke).toHaveBeenCalledWith("rec_rerecord", undefined);
    expect(h.invoke).toHaveBeenCalledWith("rec_list_files", undefined);
    expect(h.invoke).toHaveBeenCalledWith("rec_delete_file", {
      path: "C:\\v\\PastePanda\\屏幕录制_a.mp4",
    });
    expect(h.invoke).toHaveBeenCalledWith("rec_open_file", {
      path: "C:\\v\\PastePanda\\屏幕录制_a.mp4",
    });
  });
});
