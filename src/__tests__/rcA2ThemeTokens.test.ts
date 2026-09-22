import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const css = readFileSync(resolve(root, "src/components/rc/RemoteComputerA2.module.css"), "utf8");
const entry = readFileSync(resolve(root, "src/rc-main.tsx"), "utf8");
const theme = readFileSync(resolve(root, "src/styles/theme.css"), "utf8");
const workbench = readFileSync(resolve(root, "src/components/rc/RcWorkbench.tsx"), "utf8");

function luminance(hex: string): number {
  const full = hex.length === 4 ? hex.replace(/./g, (value, index) => (index ? value + value : value)) : hex;
  const rgb = [1, 3, 5].map((index) => Number.parseInt(full.slice(index, index + 2), 16) / 255);
  const linear = rgb.map((value) => (value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4));
  return 0.2126 * linear[0] + 0.7152 * linear[1] + 0.0722 * linear[2];
}

function contrast(a: string, b: string): number {
  const [bright, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x);
  return (bright + 0.05) / (dark + 0.05);
}

describe("远程电脑 A2 真实主题守卫", () => {
  it("A2 只消费 PastePanda 语义变量，不写死颜色、渐变或主题分支", () => {
    expect(css).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(css).not.toMatch(/(?:linear|radial)-gradient\(/);
    expect(css).not.toContain("backdrop-filter");
    expect(css).not.toContain("[data-theme");
    expect(css).not.toContain("!important");

    for (const token of [
      "--app-bg",
      "--section-bg",
      "--card-bg",
      "--text-primary",
      "--text-secondary",
      "--border-color",
      "--accent",
      "--accent-light",
      "--accent-solid",
      "--text-on-accent",
      "--success",
      "--warning",
      "--danger",
    ]) {
      expect(css, `A2 应消费 ${token}`).toContain(`var(${token})`);
    }
    expect(theme.match(/--text-on-accent\s*:/g)?.length).toBe(6);
    expect(css).not.toContain("var(--toggle-on-label)");
  });

  /* 详情头横幅的底：A2 文件禁 gradient 字面量（上一条），所以渐变只能装在
     令牌里。令牌漏一套主题的后果不是报错，是该主题下这一横条没有底色 ——
     tsc / vitest 都看不出来，只有这条守卫能拦。 */
  it("详情头横幅令牌 --rc-head-bg 六套主题齐全，且表达式一致、从令牌派生", () => {
    const values = [...theme.matchAll(/^\s*--rc-head-bg:\s*(.+);/gm)].map((m) => m[1].trim());
    expect(values, "--rc-head-bg 应有 6 处（六套主题各一）").toHaveLength(6);

    for (const value of values) {
      expect(value, `不应写死颜色：${value}`).not.toMatch(/#[0-9a-f]{3,8}\b/i);
      expect(value, `应从现有令牌派生：${value}`).toMatch(/var\(--/);
    }
    // --accent / --card-bg 各自跟着主题走，表达式本身不该分叉
    expect(new Set(values).size, "--rc-head-bg 在六套主题里的表达式应完全相同").toBe(1);

    // 而消费方必须走这个令牌，不能在 A2 里自己拼一份渐变（那会被上一条拦下）
    expect(css).toContain("var(--rc-head-bg)");
  });

  it("独立工作台从真实配置读取主题，并实时跟随主窗口", () => {
    expect(entry).toContain('invoke<{ theme?: string }>("get_config")');
    expect(entry).toContain('"theme-changed"');
    expect(entry).toContain("applyTheme(normalizeTheme");
    expect(entry).not.toMatch(/applyTheme\("(?:ocean|ocean-dark|blossom)"\)/);
  });

  it("六套主题的主按钮文字都达到普通文字 4.5:1 对比度", () => {
    const pairs = [...theme.matchAll(/--accent-solid:\s*(#[0-9a-f]{6});[^]*?--text-on-accent:\s*(#[0-9a-f]{3,6});/gi)];
    expect(pairs).toHaveLength(6);
    for (const [, background, text] of pairs) {
      expect(contrast(background, text), `${text} on ${background}`).toBeGreaterThanOrEqual(4.5);
    }
  });

  it("非会话页面也常驻展示并可关闭远程错误", () => {
    expect(workbench).toContain("rc.error &&");
    expect(workbench).toContain("<RcErrorPanel");
    expect(workbench).toContain("onDismiss={rc.clearError}");
  });
});
