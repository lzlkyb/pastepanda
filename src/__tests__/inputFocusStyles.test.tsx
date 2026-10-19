import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { expect, it } from "vitest";

const readCss = (file: string) => readFileSync(resolve("src", file), "utf8");
// Reversing sheet order catches the original class-vs-global specificity regression.
const fallback = readCss("styles/globals.css").replace(/@import[^;]+;/g, "");
const cases = [
  ["记录搜索", "components/TopBar.module.css", '<div class="searchBox focused"><input class="searchInput"></div>'],
  ["设置搜索", "components/Settings.module.css", '<div class="settingsSearchBox"><input class="settingsSearchInput"></div>'],
  ["知识搜索", "components/KnowledgeView.module.css", '<div class="searchBox"><input class="searchInput"></div>'],
  ["知识提问", "components/KnowledgeView.module.css", '<div class="searchBox searchBoxTall"><textarea class="searchInput askArea"></textarea></div>'],
  ["来源搜索", "components/history-source/HistorySource.module.css", '<div class="panel"><label class="search"><input></label></div>'],
  ["批量替换", "components/BatchReplaceDialog.module.css", '<div class="inputRow"><input class="input"></div>'],
  ["查找流程", "components/ChainRunnerDialog.module.css", '<label class="search"><input></label>'],
  ["查找变换", "components/TransformHub.module.css", '<label class="toolSearch"><input></label>'],
  ["快捷粘贴", "styles/quickpaste.css", '<div class="qp-search"><input></div>'],
  ["截图动作", "styles/screenshot.css", '<div class="pop-search"><input></div>'],
  ["编辑器语言", "components/editors/FullscreenEditor.module.css", '<div class="langSearch"><input></div>'],
  ["编辑器日志", "components/editors/FullscreenEditor.module.css", '<div class="logSearch"><input></div>'],
  ["编辑器树查找", "components/editors/FullscreenEditor.module.css", '<div class="searchInput"><input></div>'],
  ["提问框", "components/Composer.module.css", '<div class="composer"><textarea class="composerInput"></textarea></div>'],
  ["单行提问框", "components/Composer.module.css", '<div class="composerSlim"><input class="composerInput"></div>'],
] as const;

function inspect(css: string, markup: string, verify: (input: HTMLInputElement | HTMLTextAreaElement) => void) {
  const fixture = document.createElement("div");
  fixture.innerHTML = `<style>${css}</style>${markup}`;
  document.body.append(fixture);
  try {
    const input = fixture.querySelector<HTMLInputElement | HTMLTextAreaElement>("input,textarea")!;
    input.focus();
    expect(input.matches(":focus-visible")).toBe(true);
    verify(input);
  } finally { fixture.remove(); }
}

it.each(cases)("%s：两种样式表顺序下均不产生内部焦点框", (_name, file, markup) => {
  const css = readCss(file);
  for (const sheets of [fallback + css, css + fallback]) inspect(sheets, markup, input => {
    expect(getComputedStyle(input).outline).toMatch(/^(none|0(?:px)?)$/);
    expect(getComputedStyle(input).borderStyle).not.toContain("solid");
  });
});

it.each([
  ["时间日期", "components/history-time/HistoryTime.module.css", '<div class="panel"><label class="datePicker"><input type="date"></label></div>'],
  ["远程设备搜索", "components/rc/RemoteComputerA2.module.css", '<div class="searchRow"><input type="search"></div>'],
  ["远程设备重命名", "components/rc/RemoteComputerA2.module.css", '<div class="renameForm"><input></div>'],
])("%s：已有边框的输入框以本体变色表达焦点，保持单框", (_name, file, markup) => {
  // Resolve just the focus ink to check the actual focused border as well as ring removal.
  const css = (fallback + readCss(file)).replace(/var\(--accent-strong\)/g, "rgb(2, 115, 173)");
  inspect(css, markup, input => {
    expect(getComputedStyle(input).outline).toMatch(/^(none|0(?:px)?)$/);
    expect(getComputedStyle(input).borderColor).toBe("rgb(2, 115, 173)");
  });
});
