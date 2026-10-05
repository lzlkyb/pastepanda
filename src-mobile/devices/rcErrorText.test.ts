import { expect, it } from "vitest";
import { rcErrorText } from "./rcErrorText";

it.each([new Error("TypeError: fetch failed"), "请求失败 token=private-value", "打开失败 C:\\Users\\private\\file.txt", "请求失败 https://host.test/?password=private", "Unhandled promise rejection", "打开失败 /storage/private/file.txt", "认证失败 密码=private", "凭据无效 PPU-private", "打开失败 \\\\server\\private"])("技术错误不进入主提示：%s", error => {
  expect(rcErrorText(error)).toMatch(/操作未能完成/);
  expect(rcErrorText(error)).not.toMatch(/private|fetch|rejection/);
});
it("保留可信的人话错误与权限、网络分类", () => {
  expect(rcErrorText(new Error("配对码已过期，请重新获取"))).toBe("配对码已过期，请重新获取");
  expect(rcErrorText("socket timeout")).toMatch(/网络连接失败/);
  expect(rcErrorText(new DOMException("denied", "NotAllowedError"), "camera")).toMatch(/未允许使用相机/);
});
