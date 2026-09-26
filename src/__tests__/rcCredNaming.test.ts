/**
 * 凭证命名守卫（方案 C + 乙方案 2026-09-26）。
 *
 * 钉住的不变量：**新写的远程界面文案不得再用已退役的凭证叫法**。
 * 四种凭证的最终命名——长期配对码 / 一次性帮助码 / 无人值守码 / 固定密码，
 * 徽章组件 `RcCredTag` 是唯一展示件。旧词全部退役的理由：
 *
 *  - 「邀请码」与知识库同步那一路撞名（那边保留原名）；
 *  - 「一次性接入码 / 无人值守接入码」与「一次性帮助码」撞名，是这轮改名的元凶；
 *  - 「不会留在设备列表 / 用后即忘」——乙方案拍板**默认保留**后成了假话，
 *    假承诺比没承诺更伤（这句原来写在出码屏，是用户对配对系统信任的来源）。
 *
 * 扫描范围只限**渲染路径**（`src/components/rc` 与 `settings/Rc*` 的非测试文件）：
 * 注释与 docs 里提旧词是历史叙述，允许。若第 N 个新组件又写出旧词，本测试应拦住它。
 */
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();

function uiSourceFiles(dir: string): string[] {
  return readdirSync(resolve(root, dir), { withFileTypes: true })
    .filter((e) => e.isFile() && e.name.endsWith(".tsx") && !e.name.includes(".test."))
    .map((e) => `${dir}/${e.name}`);
}

const files = [
  ...uiSourceFiles("src/components/rc"),
  ...uiSourceFiles("src/components/settings"),
  ...uiSourceFiles("src/components/settings/sections"),
];

const RETIRED = ["一次性接入码", "无人值守接入码", "远程邀请码", "协助码", "不会留在", "用后即忘"];

describe("凭证命名收口（方案 C 词表）", () => {
  it("扫描到了全部远程界面文件（防止路径写错导致守卫空转）", () => {
    expect(files).toContain("src/components/settings/RcPairCreatePane.tsx");
    expect(files).toContain("src/components/settings/RcUnoDialog.tsx");
    expect(files.length).toBeGreaterThan(30);
  });

  for (const word of RETIRED) {
    it(`界面源码不出现「${word}」`, () => {
      const hits = files
        .map((f) => [f, readFileSync(resolve(root, f), "utf8")] as const)
        .filter(([, src]) => src.includes(word))
        .map(([f]) => f);
      expect(hits, `这些文件还在用退役叫法：${hits.join(", ")}`).toEqual([]);
    });
  }
});
