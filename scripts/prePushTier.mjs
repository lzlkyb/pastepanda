#!/usr/bin/env node
// pre-push 的判档器：读 git 传给钩子的 ref 行，决定这次 push 要不要付全量测试。
//
// 为什么单独成文件（而不是写在钩子里的一段 case）：`.husky/pre-push` 与
// `.githooks/pre-push` 是两份必须逐字节等价的副本（见 prePushHookParity.test.ts），
// 判据写进 shell 就只能靠字符串断言；收口成纯函数后它能直接被 vitest 喂反例。
//
// stdin 格式（git 定义，每行四个字段）：
//   <local-ref> <local-sha> <remote-ref> <remote-sha>
// 某些 GUI 客户端调用钩子时不给 stdin ⇒ 读不到任何 ref，那种情况必须往重的方向掉。

import path from "node:path";
import { fileURLToPath } from "node:url";

/** 只有这两种目标会改变「别人拉到的东西」：master 尖端、以及任何 tag（tag 触发 release.yml）。 */
const HEAVY_REF = /^refs\/(heads\/master|tags\/)/;

export function decideTier(stdinText) {
  const lines = stdinText.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return "full";
  // 第 3 个字段才是被推到的远端 ref；本地分支名可能随便起，不作判据。
  return lines.some((l) => {
    const fields = l.split(/\s+/);
    // 行形如「(delete) <sha> <ref> <old>」，字段数不对说明我们读不懂它——读不懂就往重的方向掉。
    if (fields.length < 4) return true;
    return HEAVY_REF.test(fields[2]);
  })
    ? "full"
    : "light";
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  process.stdout.write(decideTier(Buffer.concat(chunks).toString("utf8")));
}
