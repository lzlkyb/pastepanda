import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import {
  DEFAULT_GITEE_REPO,
  TARGETS,
  deriveManifest,
  giteeRawManifestUrl,
  toGiteeUrl,
} from "./repair-gitee-channel.mjs";

const GH = "https://github.com/lzlkyb/pastepanda/releases/download/v7.2.10/PastePanda_7.2.10_x64-setup.exe";

it("换主机不换路径：tag 与文件名必须原样带过去", () => {
  expect(toGiteeUrl(GH, "lzul/pastepanda")).toBe(
    "https://gitee.com/lzul/pastepanda/releases/download/v7.2.10/PastePanda_7.2.10_x64-setup.exe",
  );
});

// 下面四条反例是本函数的全部价值所在：它宁可拒绝，也不"顺手改一下"。
// 只要有一条被放宽（例如改成贪婪 replace），补出去的 manifest 就是客户端下不动的地址。
it("ghproxy 包裹的地址必须拒绝，不能剥掉代理前缀当成真身", () => {
  expect(() => toGiteeUrl(`https://ghproxy.net/${GH}`, "lzul/pastepanda")).toThrow(/不是本仓 GitHub 发行版直链/);
});

it("已经是 Gitee 附件地址的必须拒绝（重复修复不许套娃出 gitee/gitee）", () => {
  expect(() => toGiteeUrl(toGiteeUrl(GH, "lzul/pastepanda"), "lzul/pastepanda")).toThrow(/不是本仓 GitHub 发行版直链/);
});

it("带 query 的地址必须拒绝（签名过期的直链补出去照样 403）", () => {
  expect(() => toGiteeUrl(`${GH}?sign=xxx`, "lzul/pastepanda")).toThrow(/形态异常/);
});

it("别人的仓库必须拒绝（镜像到没人读的仓库比 404 更难发现）", () => {
  expect(() =>
    toGiteeUrl("https://github.com/someone-else/pastepanda/releases/download/v1/a.exe", "lzul/pastepanda"),
  ).toThrow(/不是本仓 GitHub 发行版直链/);
});

const desktop = {
  version: "7.2.10",
  notes: "- feat: x",
  pub_date: "2026-10-06T10:00:00Z",
  platforms: {
    "windows-x86_64": { signature: "dW50cnVzdGVkIGNvbQ==", url: GH },
  },
};

it("桌面 manifest：签名原样保留，逐平台换 URL，其余字段不动", () => {
  const out: any = deriveManifest("desktop", desktop, "lzul/pastepanda");
  expect(out.platforms["windows-x86_64"].signature).toBe("dW50cnVzdGVkIGNvbQ==");
  expect(out.platforms["windows-x86_64"].url).toContain("gitee.com/lzul/pastepanda/releases/download/");
  expect(out.version).toBe("7.2.10");
  expect(out.notes).toBe("- feat: x");
});

it("桌面 manifest 缺签名 → 拒绝（补出去客户端必然验签失败）", () => {
  const noSig = JSON.parse(JSON.stringify(desktop));
  noSig.platforms["windows-x86_64"].signature = "";
  expect(() => deriveManifest("desktop", noSig, "lzul/pastepanda")).toThrow(/缺 signature/);
});

it("桌面 manifest platforms 为空 → 拒绝（那是条什么都不承诺的 manifest）", () => {
  expect(() => deriveManifest("desktop", { ...desktop, platforms: {} }, "lzul/pastepanda")).toThrow(/platforms/);
});

const apk = {
  version: "7.2.10",
  notes: "- feat: x",
  url: "https://github.com/lzlkyb/pastepanda/releases/download/v7.2.10/PastePanda_7.2.10_universal-release.apk",
  sha256: "a".repeat(64),
};

it("APK manifest：sha256 是客户端唯一的完整性依据，形态不对就拒绝", () => {
  expect(deriveManifest("apk", apk, "lzul/pastepanda").url).toContain("gitee.com/");
  for (const bad of ["", "ABC", "a".repeat(63), "a".repeat(65)]) {
    expect(() => deriveManifest("apk", { ...apk, sha256: bad }, "lzul/pastepanda")).toThrow(/sha256/);
  }
});

// ─── 跨文件守卫：客户端硬编码的地址 ≡ 本脚本修复的地址 ───
// 本脚本按 releases/latest/<name> 这个形状读写。谁改了 tauri.conf.json 的第 1 条端点
// （换仓库、换分支、换文件名、甚至把它从第 1 条挪走），这里必须立刻变红——否则定时自愈
// 每天都在认真修复一条没有客户端会去读的路径，全绿但零作用。
it("tauri.conf.json 的第 1 条更新源必须就是本脚本修复的那两个地址", () => {
  const conf = JSON.parse(readFileSync(path.resolve("src-tauri/tauri.conf.json"), "utf8"));
  const updater = conf.plugins.updater;
  const lists: Record<string, string[]> = {
    endpoints: updater.endpoints,
    apkEndpoints: updater.apkEndpoints,
  };
  for (const t of TARGETS as any[]) {
    const list = lists[t.list];
    expect(list, `tauri.conf.json 缺 plugins.updater.${t.list}`).toBeTruthy();
    expect(list[0]).toBe(giteeRawManifestUrl(DEFAULT_GITEE_REPO, t.name));
  }
  // manifest 里那条 exe 直链也必须落在同一个仓库路径上：否则「读到了新版本，下载的是另一个仓库」
  const derived: any = deriveManifest("desktop", desktop, DEFAULT_GITEE_REPO);
  const attachmentRepo = new URL(derived.platforms["windows-x86_64"].url).pathname.split("/").slice(0, 3).join("/");
  expect(attachmentRepo).toBe(new URL(lists.endpoints[0]).pathname.split("/").slice(0, 3).join("/"));
});
