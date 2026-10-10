import { configure } from "@testing-library/dom";

// findBy*/waitFor 不写显式超时时，默认值取自这里（实测：
// @testing-library/dom/dist/wait-for.js:16 用 getConfig().asyncUtilTimeout，出厂 1000ms）。
// 1000ms 在满载机器上不够：pre-push 前面刚跑完全树扫描，异步加载的列表还没落到 DOM
// 就判红——2026-10-08 实测 KnowledgeView.test.tsx 那条 findByRole 单独 6 连跑全绿、
// 全仓并发跑挂一次。已写显式超时的用例不受影响，所以这里只兜默认值。
configure({ asyncUtilTimeout: 3_000 });
