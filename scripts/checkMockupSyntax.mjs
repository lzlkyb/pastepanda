// 语法体检：把 HTML 里每个 <script> 块交给 new Function 解析一次。
// 起因（2026-10-11）：模板字符串里一个残缺三元 `${a === null ? '>' : ''}` 让整块 <script> 解析失败，
// 页面看着正常、表格全空、浏览器控制台一条消息都不报。
import fs from "node:fs";
import path from "node:path";

const dir = "D:/AItool/winapp/pastePanda/design";
const files = process.argv.slice(2);
let bad = 0;
for (const f of files) {
  const p = path.join(dir, f);
  const html = fs.readFileSync(p, "utf8");
  const blocks = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)];
  console.log(`\n== ${f}  (${blocks.length} 个 script 块)`);
  blocks.forEach((b, i) => {
    try {
      new Function(b[1]);
      console.log(`   块 ${i + 1}: 解析 OK  (${b[1].split("\n").length} 行)`);
    } catch (e) {
      bad++;
      console.log(`   块 ${i + 1}: 🔴 ${e.name}: ${e.message}`);
    }
  });
}
process.exit(bad ? 1 : 0);
