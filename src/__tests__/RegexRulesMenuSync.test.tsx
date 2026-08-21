/**
 * 正则规则改动后，卡片右键菜单要跟着变。
 *
 * 原缺陷：`getEnabledRules()` 同步读 regexRules.ts 里的模块级 `_cache`，写入 API 原地改它
 * 且**不通知任何人**；而 CardWithContext 把菜单放进了 `useMemo`，依赖表里没有规则版本。
 * 于是在「管理正则规则…」加/删/启停规则之后，右键菜单里的「正则替换」子菜单还是旧的，
 * 要等别的原因触发卡片重渲染才刷新 —— 用户会以为规则没保存上。
 *
 * 这跟 AI 配置那次是同一类问题（写方不广播 + 读方 memo 化），所以同样收口成
 * 「改完 _cache 只准调一个函数」。下面第一组就是钉这个收口：任何一个写入 API
 * 漏掉通知都会挂。
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import {
  _resetCache,
  initRegexRules,
  getRulesVersion,
  subscribeRules,
  getEnabledRules,
  addCustomRule,
  updateCustomRule,
  deleteCustomRule,
  toggleCustomRule,
  togglePresetRule,
} from "@/lib/regexRules";
import { CardWithContext } from "@/components/Card";
import { CtxMenuCtx, type MenuItem } from "@/components/ContextMenu";
import type { HistoryItem } from "@/stores/appStore";

vi.mock("@/components/Toast", () => ({ useToast: () => ({ toast: vi.fn() }) }));
vi.mock("@/hooks/useActionEventLog", () => ({ useActionEventLog: () => ({ log: vi.fn() }) }));
vi.mock("@/lib/pasteGuard", () => ({ pasteGuarded: vi.fn().mockResolvedValue(true) }));

describe("regexRules 写入必须通知订阅者（收口）", () => {
  beforeEach(async () => {
    _resetCache();
    await initRegexRules();
  });

  /** 跑一个写操作，返回 [版本号是否自增, 订阅者是否被叫到] */
  const observe = (write: () => void): [boolean, boolean] => {
    const before = getRulesVersion();
    const spy = vi.fn();
    const un = subscribeRules(spy);
    write();
    un();
    return [getRulesVersion() > before, spy.mock.calls.length > 0];
  };

  it("addCustomRule 通知", () => {
    expect(observe(() => addCustomRule({ name: "新规则", pattern: "a", replacement: "b", flags: "g", enabled: true, sort_order: 99 }))).toEqual([true, true]);
  });

  it("updateCustomRule 通知", () => {
    const r = addCustomRule({ name: "待改", pattern: "a", replacement: "b", flags: "g", enabled: true, sort_order: 99 });
    expect(observe(() => updateCustomRule(r.id, { name: "改过了" }))).toEqual([true, true]);
  });

  it("deleteCustomRule 通知", () => {
    const r = addCustomRule({ name: "待删", pattern: "a", replacement: "b", flags: "g", enabled: true, sort_order: 99 });
    expect(observe(() => deleteCustomRule(r.id))).toEqual([true, true]);
  });

  it("toggleCustomRule 通知", () => {
    const r = addCustomRule({ name: "待切", pattern: "a", replacement: "b", flags: "g", enabled: true, sort_order: 99 });
    expect(observe(() => toggleCustomRule(r.id))).toEqual([true, true]);
  });

  it("togglePresetRule 通知", () => {
    expect(observe(() => togglePresetRule("p1"))).toEqual([true, true]);
  });

  it("退订之后不再收到通知", () => {
    const spy = vi.fn();
    subscribeRules(spy)();
    addCustomRule({ name: "x", pattern: "a", replacement: "b", flags: "g", enabled: true, sort_order: 99 });
    expect(spy).not.toHaveBeenCalled();
  });

  it("initRegexRules 加载完也要通知（在它之前渲染的界面拿到的是默认值）", async () => {
    _resetCache();
    const spy = vi.fn();
    const un = subscribeRules(spy);
    await initRegexRules();
    un();
    expect(spy).toHaveBeenCalled();
  });
});

const ITEM: HistoryItem = {
  id: "it-1",
  text: "hello world",
  time: "2026-08-20 10:00:00",
  type: "text",
  content: "",
  pinned: false,
  source: "test.exe",
  workspace: "default",
  content_type: "plain",
};

describe("卡片右键菜单跟随规则变更", () => {
  /** 捕获卡片交给 ContextMenu 的菜单项 */
  let captured: MenuItem[] = [];

  beforeEach(async () => {
    captured = [];
    _resetCache();
    await initRegexRules();
    render(
      <CtxMenuCtx.Provider value={(_x, _y, items) => { captured = items; }}>
        <CardWithContext
          item={ITEM}
          selected={false}
          onClick={vi.fn()}
          onDoubleClick={vi.fn()}
          index={0}
          onRegexPreview={vi.fn()}
          onManageRegexRules={vi.fn()}
        />
      </CtxMenuCtx.Provider>,
    );
  });

  /** 在卡片上右键，读出「正则替换」子菜单里的规则名 */
  const regexRuleNames = (): string[] => {
    fireEvent.contextMenu(screen.getByRole("option"));
    const group = captured.find((i) => i.label === "正则替换");
    return (group?.children ?? []).map((c) => c.label);
  };

  it("初始就能看到预设规则", () => {
    const names = regexRuleNames();
    expect(names.length).toBeGreaterThan(0);
    expect(names).toContain("管理正则规则…");
  });

  it("新加的规则要立刻出现在菜单里（原 bug：memo 不重算，看不到）", () => {
    expect(regexRuleNames()).not.toContain("我的新规则");

    act(() => {
      addCustomRule({ name: "我的新规则", pattern: "x", replacement: "y", flags: "g", enabled: true, sort_order: 99 });
    });

    expect(regexRuleNames()).toContain("我的新规则");
  });

  it("停用某条规则后它要从菜单里消失", () => {
    const target = getEnabledRules()[0].name;
    expect(regexRuleNames()).toContain(target);

    act(() => {
      togglePresetRule(getEnabledRules()[0].id);
    });

    expect(regexRuleNames()).not.toContain(target);
  });

  it("删掉自定义规则后它要从菜单里消失", () => {
    let id = "";
    act(() => {
      id = addCustomRule({ name: "待删规则", pattern: "x", replacement: "y", flags: "g", enabled: true, sort_order: 99 }).id;
    });
    expect(regexRuleNames()).toContain("待删规则");

    act(() => {
      deleteCustomRule(id);
    });

    expect(regexRuleNames()).not.toContain("待删规则");
  });
});
