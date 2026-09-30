/**
 * 「远程电脑」分组折叠的四条守卫（设计稿 §6 的落地清单）。
 *
 * 这四条的失效方式全是**不报错、只是行为悄悄变了**，所以逐条钉：
 *
 * ① 搜索非空 ⇒ 四个组全部展开渲染。判据收在 `rcGroupShouldOpen` 一个纯函数里
 *    （规则 11.1：如果第 5 个组写出来时仍会漏掉这条，说明还没收口）。
 * ② `sectionTitleOf` 必须**优先 data-label、且保留 textContent 回退**：
 *    组头收起态挂着状态摘要，取 textContent 会让结果条写成
 *    「分布在『谁能连进来已配对3…』」；反过来去掉回退，会让
 *    「搜小节名 ⇒ 整节展开」这条既有行为静默消失（本稿第一版就漏过）。
 * ③ 组名 + 摘要不得与任何菜单 / 小节 label **全等**——`useSettingsNav` 的
 *    `findNavEl`(:171) 与 scroll-spy(:329) 都按 `textContent.trim() === label`
 *    找落点，一旦全等，点菜单会滚到组头上。
 * ④ 组头摘要里的计数必须来自 props，不许是写死的字面量。
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { render, screen } from "@testing-library/react";
import { rcGroupShouldOpen, RC_GROUP_DEFAULTS, type RcSettingsGroup } from "@/lib/rcPrefs";
import { sectionTitleOf } from "@/hooks/useSettingsSearch";
import { unoExpiryText } from "@/lib/rcUno";
import {
  SETTINGS_SECTIONS,
  SETTINGS_SUBSECTIONS,
} from "@/components/settings/sections/meta";
import { RcPairGroup } from "@/components/settings/rcGroups/RcPairGroup";
import { RcRecentGroup } from "@/components/settings/rcGroups/RcRecentGroup";
import { RcUnoGroup } from "@/components/settings/rcGroups/RcUnoGroup";
import type { UseRc } from "@/hooks/useRc";
import type { RcStatus, RcTargetDevice } from "@/lib/api/rc";
import { ToastProvider } from "@/components/Toast";

const GROUPS = Object.keys(RC_GROUP_DEFAULTS) as RcSettingsGroup[];

describe("① 搜索期间强制展开（判据只有一处）", () => {
  it("关键词非空 ⇒ 即使用户收起也展开", () => {
    for (const g of GROUPS) {
      expect(rcGroupShouldOpen(false, "画质"), g).toBe(true);
    }
  });
  it("关键词为空或只有空格 ⇒ 回到用户态", () => {
    expect(rcGroupShouldOpen(true, "")).toBe(true);
    expect(rcGroupShouldOpen(false, "")).toBe(false);
    // 只有空格：搜索框里的空格不该把四个组全撑开（`filter.trim()` 口径与 hook 一致）
    expect(rcGroupShouldOpen(false, "   ")).toBe(false);
  });
  it("默认只有「谁能连进来」展开——它是唯一可能有请求在等的组", () => {
    expect(RC_GROUP_DEFAULTS).toEqual({ pair: true, conn: false, cap: false, recent: false });
  });
});

describe("② 节标题：data-label 优先、textContent 兜底", () => {
  it("组头带摘要时取 data-label，不让数字进横幅", () => {
    const el = document.createElement("div");
    el.dataset.label = "谁能连进来";
    el.textContent = "谁能连进来已配对3 · 待确认1 · 指纹 7F2C·A91B";
    expect(sectionTitleOf(el)).toBe("谁能连进来");
  });
  it("没有 data-label 的普通小节标题照旧取文字", () => {
    const el = document.createElement("div");
    el.textContent = "  远程电脑  ";
    expect(sectionTitleOf(el)).toBe("远程电脑");
  });
  it("data-label 是空串时仍回退 textContent（空串是 falsy，不是「故意留空」）", () => {
    const el = document.createElement("div");
    el.dataset.label = "";
    el.textContent = "同步与互联";
    expect(sectionTitleOf(el)).toBe("同步与互联");
  });
});

/** 扫 rcGroups 源码取组名字面量：③④ 两条都要它，而组名就写在 RcGroupHead 的 label 上。 */
function groupLabels(): string[] {
  const dir = join(process.cwd(), "src", "components", "settings", "rcGroups");
  const out: string[] = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith(".tsx")) continue;
    const src = readFileSync(join(dir, f), "utf8");
    for (const m of src.matchAll(/<RcGroupHead[\s\S]{0,80}?label="([^"]+)"/g)) out.push(m[1]);
  }
  return out;
}

describe("③ 组头永远不会被左菜单 / 跳小节误认成锚点", () => {
  it("四个组各有一个组头，不多不少", () => {
    expect(groupLabels()).toHaveLength(4);
  });
  it("组名 + 摘要拼起来仍不得等于任何菜单 label 或小节锚点（findNavEl 判全等）", () => {
    const navLabels = new Set<string>([
      ...SETTINGS_SECTIONS.map((s) => s.label),
      ...Object.values(SETTINGS_SUBSECTIONS).map((s) => s.label),
    ]);
    for (const label of groupLabels()) {
      // 组头收起态的 textContent = 组名 + 摘要；这里用「组名 + 一串摘要」两种形态都判一次
      expect(navLabels.has(label)).toBe(false);
      expect(navLabels.has(`${label}已配对3 · 待确认1`)).toBe(false);
    }
  });
});

/** 只填摘要要用的那几个字段，其余给空——测试关心的是「数字从 props 来」。 */
function fakeStatus(over: Partial<RcStatus> = {}): RcStatus {
  return {
    enabled: true,
    running: true,
    capability: "control",
    quality: "auto",
    capture_scope: "virtual",
    device_deny: {},
    joins: [],
    uno: [],
    ...over,
  } as RcStatus;
}

function fakeRc(over: Record<string, unknown> = {}) {
  // `targetsLoaded` 必须给：摘要用它区分「还没读到」与「真的 0 台」（见下面两条 loading 断言）
  return {
    busy: false,
    identity: { fingerprint: "7F2C·A91B" },
    targetsLoaded: true,
    targetsError: null,
    ...over,
  } as unknown as UseRc;
}

const dev = (node_id: string, trusted: boolean): RcTargetDevice =>
  ({ node_id, name: node_id, trusted }) as RcTargetDevice;

describe("④ 收起态摘要的计数与真值同源", () => {
  function renderPairGroup(
    targets: RcTargetDevice[],
    joins: { node_id: string }[],
    status: RcStatus | null = fakeStatus(),
    rcOver: Record<string, unknown> = {},
  ) {
    render(
      <ToastProvider>
        <RcPairGroup
          rc={fakeRc(rcOver)}
          status={status}
          targets={targets}
          joins={joins as RcStatus["joins"]}
          open={false}
          devOpen={false}
          onToggle={() => {}}
          onToggleDev={() => {}}
          onOverlay={() => {}}
        />
      </ToastProvider>,
    );
  }

  it("已配对 / 待确认 / 免确认 三个数随 props 变", () => {
    renderPairGroup([dev("a", true), dev("b", false)], [{ node_id: "c" }, { node_id: "d" }]);
    const sum = screen.getByText("谁能连进来").parentElement?.textContent ?? "";
    expect(sum).toContain("已配对2");
    expect(sum).toContain("待确认2");
    expect(sum).toContain("免确认1");
    // 指纹也是真值：identity 给什么就写什么，不写死
    expect(sum).toContain("7F2C·A91B");
  });

  // 收起态摘要是用户唯一看得见的现状，「还没读到」报成「0 台」就是断言
  it("数据没回来 ⇒ 摘要写「读取中…」，不报 0", () => {
    renderPairGroup([], [], null);
    const sum = screen.getByText("谁能连进来").parentElement?.textContent ?? "";
    expect(sum).toContain("读取中…");
    expect(sum).not.toContain("已配对0");
  });

  it("读列表失败 ⇒ 说「读取失败」，既不报 0 也不假装还在读", () => {
    renderPairGroup([], [], fakeStatus(), { targetsLoaded: false, targetsError: "通道未就绪" });
    const sum = screen.getByText("谁能连进来").parentElement?.textContent ?? "";
    expect(sum).toContain("设备列表读取失败");
    expect(sum).not.toContain("已配对0");
  });

  it("组 4 同理：历史还在读 ⇒ 「读取中…」，不写成「暂无记录」", () => {
    render(
      <RcRecentGroup
        history={{ list: [], loading: true, err: null }}
        targets={[]}
        running
        busy={false}
        open={false}
        onToggle={() => {}}
        onReconnect={() => {}}
      />,
    );
    const sum = screen.getByText("最近会话").parentElement?.textContent ?? "";
    expect(sum).toContain("读取中…");
    expect(sum).not.toContain("暂无记录");
  });
});

describe("无人值守剩余时间文案（组头摘要与行 desc 共用）", () => {
  const NOW = 1_700_000_000_000;
  it("整小时向下取整；不足一小时至少报 1 分钟，不许报 0", () => {
    expect(unoExpiryText([NOW + 2 * 3_600_000], NOW)).toBe("2 小时后过期");
    expect(unoExpiryText([NOW + 47 * 60_000], NOW)).toBe("47 分钟后过期");
    expect(unoExpiryText([NOW + 20_000], NOW)).toBe("1 分钟后过期");
    expect(unoExpiryText([NOW - 9_000_000], NOW)).toBe("1 分钟后过期");
  });
  it("空列表返回 null ⇒ 调用方不写这半句，而不是编一个「0 分钟」", () => {
    expect(unoExpiryText([], NOW)).toBeNull();
  });
});

/**
 * ⑤ 主开关关 ⇒ 只锁「新开授权」的两个按钮，安全出口与出站动作必须还能按。
 *
 * 这条是本轮重构**真的写坏过**的地方：分组时把 `off` 一股脑挂到了每一行上，
 * 于是关掉「允许被远程」之后——撤销已发的无人值守码按不动、粘对方的码连不出去、
 * 配对按钮永久灰着。三件事都与「被远程」无关，把它们一起锁掉不是「表意关闭」，是砍功能。
 * `RcPairGroup`/`RcRecentGroup` 这一轮直接不再接 `off` 这个 prop（作用域里没有它 = 写不错），
 * 而组 2 必须留着 `off` 给「生成 / 设置密码」，所以第 8 个按钮新写出来时仍可能挂错——靠这条钉。
 */
describe("⑤ 主开关关：只锁新开授权，不锁安全出口与出站", () => {
  function renderUnoGroup(off: boolean) {
    render(
      <ToastProvider>
        <RcUnoGroup
          rc={fakeRc()}
          status={fakeStatus({
            uno: [{ expires_ms: Date.now() + 600_000 }] as RcStatus["uno"],
            uno_pass: { cap: "view", wan: false } as RcStatus["uno_pass"],
          })}
          off={off}
          open
          onToggle={() => {}}
          onOverlay={() => {}}
        />
      </ToastProvider>,
    );
  }

  /** 本仓没装 jest-dom，禁用态按既有写法直接读 `.disabled`。 */
  const btn = (name: string) => screen.getByRole("button", { name }) as HTMLButtonElement;

  it("通道开着 ⇒ 五个按钮全可点", () => {
    renderUnoGroup(false);
    for (const name of ["生成", "撤销", "粘贴连接", "修改", "关闭"]) {
      expect(btn(name).disabled, name).toBe(false);
    }
  });

  it("主开关关 ⇒ 「生成」「修改（固定密码）」禁用；撤销 / 关闭 / 粘贴连接仍可点", () => {
    renderUnoGroup(true);
    expect(btn("生成").disabled).toBe(true);
    expect(btn("修改").disabled).toBe(true);
    // 关通道 ≠ 收回已经发出去的码——这两个出口被锁住就是安全漏洞还在生效
    expect(btn("撤销").disabled).toBe(false);
    expect(btn("关闭").disabled).toBe(false);
    // 出站：我连别人，不需要本机接受被远程
    expect(btn("粘贴连接").disabled).toBe(false);
  });
});

/**
 * ⑥ 设置窗的 identity / targets **只有 RcSection 会拉**（store 的轮询只探 `rc_status`，
 * `refreshTargets` 只在 `run()` 后顺带调、`refreshIdentity` 只有工作台调）。
 * 折叠重排时这段 `useEffect` 被整体删过一次，表现是「已配对 0 台 + 指纹永远读取中…
 * + 配对按钮永久禁用」——全是静默的，没有任何报错，所以按源码钉。
 */
describe("⑥ RcSection 必须自己拉身份与设备列表", () => {
  const src = readFileSync(
    join(process.cwd(), "src", "components", "settings", "sections", "RcSection.tsx"),
    "utf8",
  );
  it("挂载 / 主开关变化时 refresh + refreshTargets + refreshIdentity 三下都在", () => {
    expect(src).toContain("rc.refresh()");
    expect(src).toContain("rc.refreshTargets()");
    expect(src).toContain("rc.refreshIdentity()");
  });
});
