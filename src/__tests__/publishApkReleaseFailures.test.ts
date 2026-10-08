import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/**
 * 钉住 2026-10-09 首次真实 APK 三源发布连炸两跑暴露的两条死法（靶子是 `scripts/publish-apk.mjs`）：
 *
 * 一跑：Node 的 `shell: true` **不转义** args，只是把它们用空格**拼接**成一条命令串
 * （Node 24 运行时就有 DEP0190 警告）。于是
 * `commit -m "release: apk-update v7.2.11"` 到了 git 变成 message=`release:` 外加两个 pathspec，
 * CI 报 `error: pathspec 'apk-update' did not match any file(s) known to git`。
 * 这类 bug 的坏味道是「只在带空格的参数上发作」——干跑一次不带空格的命令永远发现不了。
 *
 * 二跑：Gitee 那条只放 manifest 的 orphan 分支 `releases` 会被镜像同步剪掉，脚本原先假定它存在。
 */

const ROOT = path.resolve(__dirname, "../..");
const MSG = "release: apk-update v7.2.11";
const ID = [
  "-c",
  "user.email=guard@pastepanda.local",
  "-c",
  "user.name=guard",
  "-c",
  "commit.gpgsign=false",
];

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "pp-shell-argv-"));
const repo = path.join(tmp, "repo");

function git(args: string[], opts: { shell?: boolean } = {}) {
  return spawnSync("git", args, { cwd: repo, encoding: "utf8", shell: opts.shell });
}

beforeAll(() => {
  fs.mkdirSync(repo, { recursive: true });
  git(["init", "-q", "-b", "releases"]);
  git([...ID, "commit", "-q", "--allow-empty", "-m", "seed"]);
  fs.writeFileSync(path.join(repo, "latest.txt"), "apk-update\n");
  git(["add", "-A", "latest.txt"]);
});

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe("spawnSync 的 shell 拼接会毁掉带空格的参数", () => {
  it("同一个 argv：开 shell 被拆成 message + pathspec，不开 shell 正常提交", () => {
    const bad = git([...ID, "commit", "-m", MSG], { shell: true });
    expect(bad.status, "开 shell 竟然提交成功了——这台机器的 Node 已改成转义 args，守卫该重写").not.toBe(0);
    expect(bad.stderr).toMatch(/pathspec 'apk-update' did not match/);

    git(["reset", "-q"]);
    git(["add", "-A", "latest.txt"]);
    const good = git([...ID, "commit", "-m", MSG]);
    expect(good.stderr.trim(), "不带 shell 的提交本不该报错").toBe("");
    expect(good.status).toBe(0);
    // 提交信息必须是完整一句，不是被截断的 `release:`
    expect(git(["log", "-1", "--pretty=%s"]).stdout.trim()).toBe(MSG);
  });

  it("publish-apk.mjs 里一个 shell:true 都不许留（Gitee 通道走过的那批调用）", () => {
    const src = fs.readFileSync(path.join(ROOT, "scripts", "publish-apk.mjs"), "utf8");
    expect(src).not.toMatch(/shell:\s*true/);
    // 反向红线：这条守卫不能是空守卫——靶子里本来确实有若干条 git/gh 调用。
    expect((src.match(/spawnSync\(/g) || []).length, "publish-apk.mjs 的 spawnSync 调用数变了，先确认是不是解析错了文件").toBeGreaterThanOrEqual(6);
  });

  it("靶子仍在跑 Gitee 通道（不是靠把功能删掉才变绿的）", () => {
    const src = fs.readFileSync(path.join(ROOT, "scripts", "publish-apk.mjs"), "utf8");
    expect(src).toMatch(/attach_files/);
    expect(src).toMatch(/commit", "-m"/);
  });
});

/**
 * 第二跑（run 37826107070）的死因与第一跑无关：`git clone --branch releases` 直接
 * `Remote branch releases not found in upstream origin`。Gitee 的 GitHub→Gitee 镜像同步只保
 * master，orphan 分支 `releases` 会被剪掉——桌面 17:46 刚重建，18:53 手机这轮就查无此分支。
 * 所以「分支可能根本不存在」必须是脚本自己能处理的正常臂（配方抄 release.yml 的 Gitee 段），
 * 否则每次发版都要先手动跑一遍 gitee-repair 才推得动 APK manifest。
 */
describe("Gitee 的 releases 分支查无时就地重建", () => {
  const src = fs.readFileSync(path.join(ROOT, "scripts", "publish-apk.mjs"), "utf8");

  it("有 clone 失败臂，且认得「分支不存在」这句 git 原文", () => {
    expect(src, "分支不存在的判据没了——镜像同步剪掉 releases 时会当成未知错误硬失败").toMatch(
      /Remote branch releases not found/,
    );
    expect(src, "没有孤儿分支重建臂").toMatch(/checkout", "--orphan", "releases"/);
    expect(src, "重建后必须清空索引，否则 master 的文件会整份跟进 releases 分支").toMatch(
      /reset", "--hard"/,
    );
  });

  it("不再假定 latest/ 一定存在（新建的孤儿分支里它当然是空的）", () => {
    expect(src, "又用回「latest/ 不存在就 fail」了").not.toMatch(/没有 latest\/ 目录/);
    expect(src).toMatch(/mkdirSync\(latest/);
  });

  it("未知失败仍然硬红（不许把鉴权失败/仓库名写错也当成「分支不存在」重建一遍）", () => {
    const arm = src.match(/if \(clone\.status !== 0\) \{([\s\S]{0,400}?)\n {4}info\(/);
    expect(arm, "找不到「先判未知错误、再走重建」的结构，守卫解析不到就别自称有效").toBeTruthy();
    expect((arm as RegExpMatchArray)[1]).toMatch(/fail\(/);
  });
});
