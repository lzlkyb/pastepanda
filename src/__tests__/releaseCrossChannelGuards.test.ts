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
 * 「每 6 小时一次」这种档在 GitHub 的 scheduler 上会**延后几个小时**（10-08 的 18:17 档
 * 23:19 才出 run），而且分字段写逗号列表会被 GitHub 判 `invalid cron attribute`、
 * 整条工作流一次都不跑 ⇒ 档期要靠一小时内多条 `- cron:` 兜住。
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

describe("自愈工作流的 cron 必须是 GitHub 认的形态", () => {
  /**
   * 2026-10-09 的教训：把档期改成 `"17,47 * * *"` 之后，本地 js-yaml 和
   * `@action-validator/cli` 都说文件没问题，但 GitHub 把它判成「workflow file issue」——
   * schedule **一次都不跑**。报错只在 workflow_dispatch 的 422 里露出来：
   *   Invalid Argument - failed to parse workflow: invalid `cron` attribute "17,47 * * *"
   * 即 Actions 的分字段不收逗号列表；要多档就写**多条 `- cron:`**。
   * 上一版守卫反过来用 `split(",")` 数分钟个数，等于给这个写法加分，
   * 于是本地全绿、线上把自愈弄死。守卫要按「平台认不认」写，不是按「我想要什么」。
   */
  const cronLines = (file: string) =>
    [...read(".github", "workflows", file).matchAll(/-\s*cron:\s*"([^"]+)"/g)].map((m) => m[1] ?? "");

  it("仓里每条 cron 的分字段都得是 GitHub 认的形态", () => {
    const dir = path.join(ROOT, ".github", "workflows");
    const files = fs.readdirSync(dir).filter((f) => /\.ya?ml$/.test(f));
    expect(files.length, "读不到 workflows 目录，守卫等于没跑").toBeGreaterThan(0);
    for (const f of files) {
      for (const c of cronLines(f)) {
        const minute = c.split(/\s+/)[0];
        expect(
          minute,
          `${f} 的 cron 分字段「${minute}」带逗号列表——GitHub 判 invalid cron attribute，整条工作流不会跑`,
        ).not.toContain(",");
        // 只允许这几种形态，其余形态没被 GitHub 的报错验证过，别赌。
        expect(
          /^(\*|(\d+(-\d+)?)|\d+\/\d+|\*\/\d+)$/.test(minute),
          `${f} 的 cron 分字段「${minute}」不是已验证过的形态（* 、*/n、n、a-b、n/k）`,
        ).toBe(true);
      }
    }
  });

  it("自愈档期一小时内 ≥2 次（剪枝实测 ≤67 分钟，且 scheduler 会延后几小时）", () => {
    const crons = cronLines("gitee-repair.yml");
    expect(crons.length, "gitee-repair.yml 没有 schedule 了——别靠删掉定时来让守卫变绿").toBeGreaterThan(0);
    const perHourOf = (c: string) => {
      const m = c.split(/\s+/)[0];
      if (m === "*") return 60;
      const step = m.match(/^\*\/(\d+)$/);
      if (step) return Math.max(1, Math.floor(60 / Number(step[1])));
      const range = m.match(/^(\d+)-(\d+)$/);
      if (range) return Number(range[2]) - Number(range[1]) + 1;
      return 1; // 单个分钟值 = 每小时一次
    };
    const perHour = crons.reduce((a, c) => a + perHourOf(c), 0);
    expect(perHour, `所有档加起来每小时只跑 ${perHour} 次，追不上 ≤67 分钟的剪枝窗口`).toBeGreaterThanOrEqual(2);
    // 而且必须是**分开的**多条，而不是同一条里的逗号（同一条会被 GitHub 拒）。
    expect(crons.length, "多档要靠多条 `- cron:` 条目，不是分字段里的逗号").toBeGreaterThanOrEqual(2);
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
