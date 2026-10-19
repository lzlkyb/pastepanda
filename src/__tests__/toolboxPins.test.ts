// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { loadToolboxPins, saveToolboxPins } from "@/lib/toolboxUsage";
import { TOOLBOX_GROUPS, filterToolItems } from "@/lib/toolbox";

beforeEach(() => localStorage.clear());
afterEach(() => vi.restoreAllMocks());

it("distinguishes the initial defaults, a saved empty list and malformed storage", () => {
  expect(loadToolboxPins()).toEqual(["sequential", "screenrec", "snippets", "remote"]);
  expect(saveToolboxPins([])).toBe(true); expect(loadToolboxPins()).toEqual([]);
  localStorage.setItem("pastepanda_toolbox_pinned", "null");
  expect(loadToolboxPins()).toHaveLength(4);
  localStorage.setItem("pastepanda_toolbox_pinned", "broken");
  expect(loadToolboxPins()).toHaveLength(4);
});

it("keeps pin order while rejecting duplicates, deleted tools and secondary actions", () => {
  localStorage.setItem("pastepanda_toolbox_pinned", JSON.stringify(["json", "json", "removed", "difffull", 42, "log", "sql", "timestamp", "diff", "qr", "encoding"]));
  expect(loadToolboxPins()).toEqual(["json", "log", "sql", "timestamp", "diff", "qr"]);
});

it("retains the last saved value when a later write fails", () => {
  saveToolboxPins(["json"]);
  vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("quota"); });
  expect(saveToolboxPins(["sql"])).toBe(false);
  expect(loadToolboxPins()).toEqual(["json"]);
});

it("keeps 17 executable actions and 16 primary entries across purpose categories", () => {
  expect(TOOLBOX_GROUPS.map(group => group.label)).toEqual(["内容整理", "文本与文件", "开发与数据", "图形与录屏", "设备连接"]);
  const tools = TOOLBOX_GROUPS.flatMap(group => group.items);
  expect(tools).toHaveLength(17);
  expect(new Set(tools.map(tool => tool.key)).size).toBe(17);
  expect(tools.filter(tool => !tool.secondaryOnly)).toHaveLength(16);
  const result = filterToolItems(tools.filter(tool => !tool.secondaryOnly), "全屏文本");
  expect(result.map(tool => tool.key)).toEqual(["diffedit"]);
});

it("preserves every original tool icon and color identity", () => {
  const actual = Object.fromEntries(TOOLBOX_GROUPS.flatMap(group => group.items).map(tool => [tool.key, [tool.icon, tool.hue]]));
  expect(actual).toEqual({
  "dailybrief": [
    "📅",
    "amber"
  ],
  "sql": [
    "🗄",
    "violet"
  ],
  "replace": [
    "🔁",
    "violet"
  ],
  "difffull": [
    "🪟",
    "green"
  ],
  "newdiagram": [
    "📊",
    "cyan"
  ],
  "sequential": [
    "📋",
    "cyan"
  ],
  "log": [
    "📜",
    "amber"
  ],
  "json": [
    "🧩",
    "cyan"
  ],
  "extract": [
    "🧲",
    "rose"
  ],
  "snippets": [
    "📝",
    "amber"
  ],
  "remote": [
    "🖥️",
    "sky"
  ],
  "screenrec": [
    "🎬",
    "sky"
  ],
  "encoding": [
    "🔤",
    "sky"
  ],
  "diffedit": [
    "🔀",
    "green"
  ],
  "qr": [
    "▦",
    "sky"
  ],
  "diff": [
    "📊",
    "green"
  ],
  "timestamp": [
    "⏱",
    "rose"
  ]
});
});