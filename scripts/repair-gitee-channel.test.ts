import { readFileSync } from "node:fs";
import path from "node:path";
import { expect, it } from "vitest";
import {
  DEFAULT_GITEE_REPO,
  TARGETS,
  assetVerdict,
  deriveManifest,
  giteeRawManifestUrl,
  giteeReleasesApiUrl,
  sanitizeUrl,
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

// ─── 附件存在性判定：证据分级 ───
// 2026-10-08 的第一版只有直链状态码一条证据，GitHub runner 到 Gitee 下载域名吃 HTTP 0，
// 自愈按设计整轮失败 ⇒ 通道永远修不上。下面每条反例对应一种「曾经会判错」的组合。
it("直链活着（200/206）就是终局证据，清单说没有也不许推翻", () => {
  expect(assetVerdict({ status: 200, inAssetList: null })).toBe("ok");
  // 清单会分页/被截断，「里面没有」推翻不了一条实际能下的地址
  expect(assetVerdict({ status: 206, inAssetList: false })).toBe("ok");
});

it("404 永远是否定证据，清单命中也不放行（客户端用的就是这条 URL）", () => {
  expect(assetVerdict({ status: 404, inAssetList: true })).toBe("missing");
  expect(assetVerdict({ status: 404, inAssetList: null })).toBe("missing");
});

it("403 是访问裁决不是存在性证据：清单命中放行，拿不到清单才判缺", () => {
  expect(assetVerdict({ status: 403, inAssetList: true })).toBe("ok");
  expect(assetVerdict({ status: 403, inAssetList: false })).toBe("missing");
  expect(assetVerdict({ status: 403, inAssetList: null })).toBe("missing");
});

// 🔴 这条就是那次 CI 失败的形态：连不上（0）既不能判「不存在」（那是编的），
// 也不能判「存在」（会发出一条下不动的 manifest）。两份证据都缺席时必须留给下一轮。
it("探不通（0/5xx）+ 清单也拿不到 → unproven，绝不猜", () => {
  expect(assetVerdict({ status: 0, inAssetList: null })).toBe("unproven");
  expect(assetVerdict({ status: 502, inAssetList: null })).toBe("unproven");
});

it("探不通（0/5xx）时清单说了算：命中放行、确认没有才判缺", () => {
  expect(assetVerdict({ status: 0, inAssetList: true })).toBe("ok");
  expect(assetVerdict({ status: 500, inAssetList: true })).toBe("ok");
  expect(assetVerdict({ status: 0, inAssetList: false })).toBe("missing");
});

it("清单地址必须带 per_page=100（匿名默认 20 条会漏掉最新发行版），没令牌就不拼令牌", () => {
  const anon = giteeReleasesApiUrl("lzul/pastepanda", "");
  expect(anon).toContain("per_page=100");
  expect(anon).not.toContain("access_token");
  expect(giteeReleasesApiUrl("lzul/pastepanda", "TK")).toBe(`${anon}&access_token=TK`);
});

// 令牌进日志 = 泄漏。日志里出现的每一行地址都得先过这一层。
it("sanitizeUrl 把令牌剥干净，带后续参数也不能漏尾巴", () => {
  const s = sanitizeUrl("https://gitee.com/api/v5/repos/x/y/releases?per_page=100&access_token=SECRET&x=1");
  expect(s).not.toContain("SECRET");
  expect(s).toContain("access_token=***");
  expect(s).toContain("x=1");
  expect(sanitizeUrl("https://a/?access_token=SECRET")).toBe("https://a/?access_token=***");
});

