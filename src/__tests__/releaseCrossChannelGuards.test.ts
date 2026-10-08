import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

/**
 * 发版链路上三条「不会在自己这一步报错」的红线（2026-10-09 读码 + 实测查出，同日整改）：
 *
 * 一、桌面 `release.yml` 的 Gitee 段原先 `Remove-Item latest/ -Recurse` 再只放
 * `updater-gitee.json`，然后 `git add -A latest` ⇒ 每次桌面发版都把**手机端**的
 * `apk-update-gitee.json` 从 releases 分支上删掉，手机第 1 更新源当场回 404。
 * 报错的是手机用户，动手的是桌面 CI，所以必须用跨文件守卫钉住。
 *
 * 二、自愈工作流的定时档：Gitee 剪掉 releases 分支的窗口实测 ≤67 分钟，而
 * 「每 6 小时一次」这种档在 GitHub 的 scheduler 上会延迟甚至**整轮跳过**
 * （2026-10-08 18:17、10-09 00:17 两轮根本没出 run）⇒ 档期要靠一小时内多跑几次兜住。
 *
 * 三、APK 签名口令的传递形态。本地原先 `apksigner.bat + shell:true`，Node 的 shell 模式
 * 不转义 args 只做拼接，而口令是以 `pass:xxx` 拼进命令串的（含 `&` `^` `%` 会断句/注入，
 * 且明文进 argv）。CI 那份虽然引号正确，同样是 `pass:` 直传。两边统一改 `env:` 引用。
 */

const ROOT = path.resolve(__dirname, "../..");
const read = (...p: string[]) => fs.readFileSync(path.join(ROOT, ...p), "utf8");

describe("桌面发版不许删掉手机端第 1 更新源", () => {
  const src = read(".github", "workflows", "release.yml");

  it("latest/ 目录不许整份清空", () => {
    expect(src, "release.yml 又清空整个 latest/ 了——那会连手机端的 apk-update-gitee.json 一起删").not.toMatch(
      /Remove-Item\s+\$destDir/,
    );
    expect(src).toMatch(/New-Item -ItemType Directory -Path \$destDir -Force/);
  });

  it("自己那份必须显式覆盖，别靠「先删再放」", () => {
    expect(src).toMatch(/Copy-Item dist\/updater-gitee\.json \$destDir\/ -Force/);
  });

  it("靶子仍在推 latest/（守卫不是靠删掉整段发版步骤才变绿的）", () => {
    expect(src).toMatch(/git add -A latest/);
    expect(src).toMatch(/releases 分支/);
  });
});

describe("Gitee 自愈的档期必须追得上剪枝窗口", () => {
  const src = read(".github", "workflows", "gitee-repair.yml");

  it("schedule 必须一小时内 ≥2 次（剪枝实测 ≤67 分钟）", () => {
    const cron = src.match(/- cron: "([^"]+)"/);
    expect(cron, "解析不到 schedule 的 cron 字段，守卫就别自称有效").toBeTruthy();
    const field = (cron as RegExpMatchArray)[1].split(/\s+/)[0];
    const perHour = field.split(",").filter((x) => /^\d+$/.test(x)).length;
    expect(perHour, `cron 分字段=${field}，一小时内只跑 ${perHour} 次，追不上 ≤67 分钟的剪枝窗口`).toBeGreaterThanOrEqual(2);
  });
});

describe("APK 签名口令不许进命令行", () => {
  const ci = read(".github", "workflows", "android.yml");
  const local = read("scripts", "android-build.mjs");

  it("CI：apksigner 用 env: 引用，且仍在签名（不是删掉才绿）", () => {
    expect(ci, "--ks-pass 又回到 pass: 直传（明文进 argv）").not.toMatch(/--ks-pass "pass:/);
    expect(ci).toMatch(/--ks-pass "env:PP_APK_KEYSTORE_PASSWORD"/);
    expect(ci).toMatch(/--key-pass "env:/);
    expect(ci).toMatch(/"\$BT\/apksigner" sign/);
  });

  it("本地：sign 调用不走 shell、口令走 env:，且仍用长期 keystore 签名", () => {
    const block = local.match(/const sign = spawnSync\([\s\S]*?\n {4}\);/);
    expect(block, "解析不到 sign 那次 spawnSync，多半是调用形态变了").toBeTruthy();
    const text = (block as RegExpMatchArray)[0];
    expect(text, "签名调用又带上 shell: 了——Node 的 shell 模式不转义 args，只做拼接").not.toMatch(/shell:/);
    expect(text).toMatch(/"--ks-pass",\s*"env:PP_APK_KS_PASS"/);
    expect(text).toMatch(/"--key-pass",\s*"env:PP_APK_KEY_PASS"/);
    expect(local, "口令以 pass: 形态拼进字符串的写法又回来了").not.toMatch(/pass:\$\{/);
    // 反向红线：绕开 .bat 不等于绕开签名。
    expect(local).toMatch(/com\.android\.apksigner\.ApkSignerTool/);
    expect(local).toMatch(/"--ks-key-alias",\s*ksProps\.keyAlias/);
  });
});
