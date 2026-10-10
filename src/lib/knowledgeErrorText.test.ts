import { expect, it } from "vitest";
import { knowledgeErrorText } from "./utils";
it("translates storage failure without exposing note content or private paths", () => {
  expect(knowledgeErrorText("database or disk is full /data/private/note.txt")).toMatch(/存储空间不足/);
  expect(knowledgeErrorText("读取 /storage/emulated/private token=secret 笔记全文")).not.toMatch(/private|secret|笔记全文/);
  expect(knowledgeErrorText(new Error("invoke unavailable"))).toMatch(/应用后台/);
});
