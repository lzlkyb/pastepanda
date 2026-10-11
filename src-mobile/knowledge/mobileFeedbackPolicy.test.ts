import { readFileSync } from "node:fs";
import { expect, it } from "vitest";

const source = (path: string) => readFileSync(new URL(path, import.meta.url), "utf8");

it("页面普通反馈不使用推挤内容的 flow Toast，面板内可以保留 flow", () => {
  for (const path of ["../devices/RcDevicesView.tsx", "../devices/RcReceivedFileActions.tsx", "./KnowledgeView.tsx"]) {
    expect(source(path), path).not.toMatch(/<MobileToast\s+placement="flow"/);
  }
});

it("用户拒绝文件请求使用中性说明，不表现为警告或故障", () => {
  expect(source("../devices/RcFileTaskList.tsx")).toContain('t.state === "denied" ? "info" : "error"');
});
