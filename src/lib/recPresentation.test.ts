import { describe, expect, it } from "vitest";
import { formatRecordingPosition, formatRecordingTime, recordingParentDir } from "./utils";

describe("recording presentation", () => {
  it("keeps sub-second editing positions distinct and handles invalid clocks", () => {
    expect(formatRecordingPosition(33)).toBe("00:00.033");
    expect(formatRecordingPosition(660)).toBe("00:00.660");
    expect(formatRecordingTime(3600123)).toBe("01:00:00");
    expect(formatRecordingTime(-100)).toBe("00:00");
    expect(formatRecordingPosition(NaN)).toBe("00:00.000");
  });
  it("preserves drive and filesystem roots across platform separators", () => {
    expect(recordingParentDir("D:\\clip.mp4")).toBe("D:\\");
    expect(recordingParentDir("/clip.mp4")).toBe("/");
    expect(recordingParentDir("D:\\clips\\clip.mp4")).toBe("D:\\clips");
    expect(recordingParentDir("/tmp/clips/clip.mp4")).toBe("/tmp/clips");
    expect(recordingParentDir("clip.mp4")).toBe("");
  });
});
