import { expect, it } from "vitest";
import { knowledgeCollectedContent, knowledgeAssetErrorText } from "./utils";
it("preserves shared text but only embeds verified portable image refs", () => {
  const safe = "pp-asset:0123456789abcdef0123456789abcdef.png";
  expect(knowledgeCollectedContent("https://example.com", [safe, safe, "content://temporary", "x)\nmalicious"])).toBe(`https://example.com\n\n![收集的图片](${safe})`);
  expect(knowledgeCollectedContent("", [safe], `已有备注\n![原图](${safe})`)).toBe(`已有备注\n![原图](${safe})`);
});
it("maps asset codes without exposing peer exception messages", () => {
  expect(knowledgeAssetErrorText({ code: "unsupported", message: "private/path" })).toContain("暂不支持单张补图");
  expect(knowledgeAssetErrorText('{"code":"offline","message":"secret"}')).toContain("确认电脑在线");
  expect(knowledgeAssetErrorText({ code: "unknown", message: "private/path" })).not.toContain("private");
});
