import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { describe, expect, it } from "vitest";

const html = readFileSync(new URL("../design/mobile-article-collection-2026-10-09.html", import.meta.url), "utf8");
const code = readFileSync(new URL("../design/mobile-article-collection-2026-10-09.js", import.meta.url), "utf8");
it("short 568px landscape uses a separate action column so large text feedback stays readable",()=>{
  const css=readFileSync(new URL("../src-mobile/knowledge/KnowledgeArticle.module.css",import.meta.url),"utf8");
  const side=css.match(/@container article-capture \(min-width:(\d+)px\) and \(max-height:500px\)/);
  expect(side).not.toBeNull(); expect(Number(side![1])).toBeLessThanOrEqual(568);
});

function prototype() {
  const dom = new JSDOM(html, { url: "http://localhost/design/", runScripts: "outside-only" });
  let reply!: (text: string) => void;
  Object.defineProperty(dom.window.navigator, "clipboard", {
    value: { readText: () => new Promise<string>(resolve => { reply = resolve; }) },
  });
  dom.window.eval(code);
  const doc = dom.window.document;
  const click = (selector: string) => (doc.querySelector(selector) as HTMLElement).click();
  const openLink = () => { click('[data-action="new"]'); click('[data-action="article"]'); };
  return { dom, doc, click, openLink, reply: (text: string) => reply(text) };
}

describe("article design prototype clipboard boundaries", () => {
  it("pasting does not submit the current URL before clipboard permission completes", () => {
    const ui = prototype();
    try {
      ui.openLink();
      (ui.doc.querySelector("#url") as HTMLTextAreaElement).value = "https://example.com/current";
      ui.click('[data-action="paste"]');
      expect(ui.doc.querySelector("#url")).not.toBeNull();
      expect(ui.doc.querySelector(".loading-title")).toBeNull();
    } finally { ui.dom.window.close(); }
  });

  it("a clipboard reply from an old collection cannot replace a newly opened input", async () => {
    const ui = prototype();
    try {
      ui.openLink();
      ui.click('[data-action="paste"]');
      ui.click('[data-action="back"]');
      ui.openLink();
      ui.reply("https://example.com/old");
      // Drain both the Node clipboard promise and JSDOM's event-handler continuation.
      await new Promise<void>(resolve => setImmediate(resolve));
      expect(ui.doc.querySelector("#url")).not.toBeNull();
      expect((ui.doc.querySelector("#url") as HTMLTextAreaElement).value).toBe("");
      expect(ui.doc.querySelector(".loading-title")).toBeNull();
    } finally { ui.dom.window.close(); }
  });
});

describe("article design prototype retained work", () => {
  it("reopening a link-only collection never invents an offline article", () => {
    const ui=prototype();
    try {
      ui.click('[data-scene="error"]'); ui.click('[data-action="bookmark-save"]');
      ui.click('[data-action="back"]'); ui.click('[data-action="existing"]');
      expect(ui.doc.querySelector(".notice")?.textContent).toContain("仅保存了链接");
      expect(ui.doc.querySelector(".note-status")?.textContent || "").not.toContain("可离线阅读");
    } finally { ui.dom.window.close(); }
  });
  it("returning from a bookmark body preview preserves its recovery entry", async () => {
    const ui=prototype();
    try {
      ui.click('[data-scene="error"]'); ui.click('[data-action="bookmark-save"]');
      ui.click('[data-action="fill-body"]');
      await new Promise(resolve=>ui.dom.window.setTimeout(resolve,1250));
      ui.click('[data-action="back"]');
      expect(ui.doc.querySelector('[data-action="resume"]')).not.toBeNull();
    } finally { ui.dom.window.close(); }
  });
  it("a new collection does not replace the unfinished article or inherit its remarks",()=>{
    const ui=prototype();
    try {
      ui.click('[data-scene="preview"]');
      const field=ui.doc.querySelector("#remarks") as HTMLTextAreaElement;
      field.value="只属于文章A"; field.dispatchEvent(new ui.dom.window.Event("input",{bubbles:true}));
      ui.click('[data-action="back"]'); ui.openLink();
      expect(ui.doc.querySelector("#url")).toBeNull();
      expect((ui.doc.querySelector("#remarks") as HTMLTextAreaElement).value).toBe("只属于文章A");
    } finally { ui.dom.window.close(); }
  });
});
