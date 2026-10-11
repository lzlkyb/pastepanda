import { describe, expect, it } from "vitest";
import { remoteCodecLabel } from "./utils";
describe("远控编码文案的单一来源", () => {
  it.each([["av1", "AV1"], ["h264", "H.264"], ["hevc", "HEVC"], ["jpeg", "JPEG"]])(
    "%s 正确显示为 %s", (codec, label) => expect(remoteCodecLabel(codec)).toBe(label),
  );
  it.each(["invalid", "toString", "constructor", "__proto__", ""])(
    "未知编码 %s 不得冒充 JPEG 或取到原型属性", codec => expect(remoteCodecLabel(codec)).toBe("未知编码"),
  );
});
