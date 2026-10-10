import { expect, it } from "vitest";
import { knowledgeArticleImageIndex, knowledgeArticleUrl } from "./utils";

it("recognizes a bare or short shared URL without intercepting ordinary multi-link notes",()=>{
  expect(knowledgeArticleUrl("https://mp.weixin.qq.com/s/demo?sn=keep&mid=1")).toBe("https://mp.weixin.qq.com/s/demo?sn=keep&mid=1");
  expect(knowledgeArticleUrl("文章标题\nhttps://example.com/article")).toBe("https://example.com/article");
  expect(knowledgeArticleUrl("https://a.example\nhttps://b.example")).toBeNull();
  expect(knowledgeArticleUrl("file:///private")).toBeNull();
  expect(knowledgeArticleUrl("https://user:password@example.com/a")).toBeNull();
  expect(knowledgeArticleUrl("一\n二\n三\n四\nhttps://example.com/a")).toBeNull();
});
it("image recovery accepts only the source/local ref recorded for this article",()=>{
  const images=[{url:"https://example.com/a.png",local:"pp-asset:00000000000000000000000000000000.png"}];
  expect(knowledgeArticleImageIndex(images,images[0].url)).toBe(0);
  expect(knowledgeArticleImageIndex(images,images[0].local)).toBe(0);
  expect(knowledgeArticleImageIndex(images,"https://other.example/b.png")).toBe(-1);
});
