/**
 * 甲方案（2026-09-29）守卫：顶缘唤出的「不遮挡」不变量（规则 11.1）。
 *
 * # 为什么存在
 * 浮条遮挡带是画面 y 12–46（`.capZone` top + `.capCapsule` margin-top 12px、高 34px），
 * 远端浏览器的标签 ✕ 与地址栏正好落在里面。原先热区 = 遮挡带同深（12px）、唤出即刻
 * 可点，且**隐藏态的胶囊矩形本身也是悬停目标**：指针从画面内部往上够标签时，浮条
 * 先把这一击吃掉。甲方案四条各堵一段，分别住在这个 hook、CSS、组件里——任何一条
 * 被改回去都不会报错，只会静默复发。
 *
 * # 守什么
 * ① `rcRevealGestureOf` 的判断表（纯函数本体，含「隐藏态不认胶囊矩形」）；
 * ② 热区深度必须**小于**胶囊离顶的偏移（3 < 12），否则「往上点」又必经热区；
 * ③ dwell / 穿透窗口两个时长都还在（0 = 形同删除）；
 * ④ 穿透期 CSS 规则与组件挂载点都在场（只在 hook 里 setThru 而没人读 = 空转）。
 *
 * # 乙档（同日）追加守的四条
 * ⑤ 隐藏态三重纪律挂 `.capFloat`——把手/微光条不得被 `visibility:hidden` 带走；
 * ⑥ 锁显判据 `rcCapsuleLockOf` 里**没有链路**（异常改成展开一次 + 把手染红）；
 * ⑦ `rcHandleStateOf` 的优先级（隐形 > 染红 > 染橙 > 常态）；
 * ⑧ `hoverReveal` 关掉＝不注册 mousemove 监听（不是注册了再忽略）。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  rcCapsuleLockOf,
  rcHandleStateOf,
  rcRevealGestureOf,
} from "./useRcCapsuleReveal";

const SRC = readFileSync(
  join(process.cwd(), "src", "hooks", "useRcCapsuleReveal.ts"),
  "utf8",
);
const CSS = readFileSync(
  join(process.cwd(), "src", "components", "rc", "RemoteComputer.module.css"),
  "utf8",
);
const TSX = readFileSync(
  join(process.cwd(), "src", "components", "rc", "RcSessionCapsule.tsx"),
  "utf8",
);

function num(name: string): number {
  const m = SRC.match(new RegExp(`const ${name} = (\\d+)`));
  if (!m) throw new Error(`hook 里找不到常量 ${name}`);
  return Number(m[1]);
}

describe("rcRevealGestureOf：一次 mousemove 的判断表", () => {
  it("已显示：悬停胶囊本体 = hold（看得见就该点得着）", () => {
    expect(rcRevealGestureOf({ overCap: true, inBand: true, shown: true })).toBe("hold");
    expect(rcRevealGestureOf({ overCap: true, inBand: false, shown: true })).toBe("hold");
  });

  it("🔴 隐藏态：胶囊本体那段矩形（远端标签栏 y 12–46）**不算**悬停目标", () => {
    // 这条是甲方案的关键一条：修前「飘过隐形胶囊就弹出且立刻可点」，
    // 用户往上够标签 ✕ 的一路先把浮条唤出来吃掉这一击。
    expect(rcRevealGestureOf({ overCap: true, inBand: false, shown: false })).toBe("idle");
  });

  it("顶缘带内：未显示 → dwell（先站住再说），已显示 → keep（只续淡出计时）", () => {
    expect(rcRevealGestureOf({ overCap: false, inBand: true, shown: false })).toBe("dwell");
    expect(rcRevealGestureOf({ overCap: false, inBand: true, shown: true })).toBe("keep");
  });

  it("既不在胶囊上也不在顶缘带内 = idle（作废在飞的 dwell）", () => {
    expect(rcRevealGestureOf({ overCap: false, inBand: false, shown: true })).toBe("idle");
    expect(rcRevealGestureOf({ overCap: false, inBand: false, shown: false })).toBe("idle");
  });
});

describe("甲方案几何与时长的不变量", () => {
  const band = num("REVEAL_BAND_PX");
  const dwell = num("REVEAL_DWELL_MS");
  const thru = num("REVEAL_THROUGH_MS");
  const inset = Number(CSS.match(/\.capCapsule\s*\{[^}]*?margin-top:\s*(\d+)px/)?.[1] ?? NaN);

  it("🔴 热区深度 < 胶囊离顶偏移：从画面内部往上点不经过热区", () => {
    expect(Number.isFinite(inset), "CSS 里找不到 .capCapsule 的 margin-top").toBe(true);
    expect(band).toBeLessThan(inset);
  });

  it("dwell 与穿透窗口都是正数（0 = 甲方案②③被静默删除）", () => {
    expect(dwell).toBeGreaterThan(0);
    expect(thru).toBeGreaterThan(0);
  });

  it("穿透期只摘 pointer-events：.capZoneThru 规则在场且组件挂上了", () => {
    const rule = CSS.match(/\.capZoneThru[^{]*\{[^}]*\}/g)?.join("") ?? "";
    expect(rule).toMatch(/pointer-events:\s*none/);
    // 🔴 必须连子元素一起摘：`.capBtn` / `.capReq` / `.hudPanel` 各自重申
    // `pointer-events: auto`，父级 none 对它们只是可覆盖的继承值——漏了 `*`
    // 等于穿透窗口对「会吃掉这一击的按钮」完全失效。
    expect(rule).toMatch(/\.capZoneThru \.capCapsule \*/);
    // 🔴 乙档：把手是 `.capCapsule` 的**兄弟**节点，`*` 覆盖不到它，而它的
    // `::after` 命中盒（y 0–20）正压在 3px 唤出带上。漏这一条，dwell 唤出的
    // 那一下会被把手自己接住——用户点的是远端标签栏。
    expect(rule).toMatch(/\.capZoneThru \.capHandle\b/);
    for (const sel of [".capBtn", ".capReq", ".hudPanel", ".capHandle"]) {
      expect(
        (CSS.match(new RegExp(`(?:^|\\n)${sel}\\s*\\{([^}]*)\\}`))?.[1] ?? "").includes(
          "pointer-events: auto"
        ),
        `${sel} 若不再重申 auto，上面那条 ` + "`*`" + ` 要求的意义要重新申述`,
      ).toBe(true);
    }
    expect(TSX).toMatch(/styles\.capZoneThru/);
    expect(SRC).toMatch(/return \{ shown, thru,/);
  });

  it("只有顶缘唤出走穿透窗口：setThru(true) 在 revealThrough 里恰好一处", () => {
    // F10 / 悬停本体是显式意图，不经穿透；一旦别处也置 thru，
    // 用户看得见浮条却点不动 = 新 bug。
    expect((SRC.match(/setThru\(true\)/g) ?? []).length).toBe(1);
    expect(SRC).toMatch(/case "dwell":[\s\S]*?revealThrough/);
  });

  it("🔴 乙档：隐藏态三重纪律挂 .capFloat 而**不是** .capZone（把手不得被卸载）", () => {
    // 乙的架构核心：把手 + 微光条住在 .capZone 直下，只有胶囊那一团吃
    // .viewToolsHidden（visibility:hidden）。有人把它挪回 root，链路异常在
    // 收起态就又变成「一个看不见的灯」（规则 15.1 复发）。
    const zone = (CSS.match(/(?:^|\n)\.capZone\s*\{([^}]*)\}/)?.[1] ?? "").trim();
    expect(zone).not.toMatch(/visibility:\s*hidden/);
    expect(zone).not.toMatch(/opacity:\s*0/);
    expect(TSX).toMatch(/styles\.capFloat[^\n]*\n?[^\n]*styles\.viewToolsHidden/);
    expect(CSS).toMatch(/\.capHandle\s*\{[^}]*pointer-events:\s*auto/);
  });

  it("🔴 乙-①：hoverReveal 关掉是**不注册监听**，不是注册了再忽略", () => {
    // 只加 `if (!hoverReveal) return` 在 handler 内部的话，dwell 计时器与监听
    // 还在跑（隐藏窗口的 mousemove 开销不白付），且「顶缘零触发」名不副实。
    expect(SRC).toMatch(/useEffect\(\s*\(\) => \{\s*if \(!hoverReveal\) return;/);
    // 依赖数组里必须有它，否则关掉开关后监听永远不重挂：偏好改了，顶缘照旧零触发
    // 或照旧弹（取决于挂载时的初值），而且 ESLint 的 exhaustive-deps 迟早找上门。
    expect(SRC).toMatch(/\}, \[[^\]]*\bhoverReveal\b[^\]]*\]\);/s);
  });

  it("🔴 乙-①：这条 effect 每次重挂都要先作废在飞的 dwell", () => {
    // 只摘监听不取消计时器的话，那 180ms 的定时器还挂在 window 上，到点照样
    // revealThrough：用户刚把「顶缘悬停唤出」关掉（或锁了指针、或浮条已被别的
    // 路径展开导致 effect 重挂），浮条却又自己弹一次。
    expect(SRC).toMatch(
      /return \(\) => \{[\s\S]{0,300}?cancelDwell\(\);[\s\S]{0,300}?stage\.removeEventListener\("mousemove", onMove\);[\s\S]{0,200}?stage\.removeEventListener\("mouseleave", onLeave\);\s*\};/,
    );
  });
});

/**
 * 🔴 乙-⑥（2026-09-29）：锁显判据。链路异常**不在**列——永久锁显等于让遮挡带
 * y 12–46 留到会话结束，正是甲方案要修的原点；告知改由常驻把手承担。
 * 这三项的共性才是锁显该管的：收起会把用户正在用的东西一起卸载。
 */
describe("rcCapsuleLockOf：锁显判据", () => {
  it("菜单 / ⋯ 面板 / ⓘ 详情任一展开 = 锁显", () => {
    expect(rcCapsuleLockOf({ menusOpen: 1, moreOpen: false, detailOpen: false })).toBe(true);
    expect(rcCapsuleLockOf({ menusOpen: 0, moreOpen: true, detailOpen: false })).toBe(true);
    expect(rcCapsuleLockOf({ menusOpen: 0, moreOpen: false, detailOpen: true })).toBe(true);
  });

  it("全收起 = 不锁（menusOpen 被 clamp 前的负数也不锁）", () => {
    expect(rcCapsuleLockOf({ menusOpen: 0, moreOpen: false, detailOpen: false })).toBe(false);
    expect(rcCapsuleLockOf({ menusOpen: -1, moreOpen: false, detailOpen: false })).toBe(false);
  });

  it("🔴 判据里没有链路：linkDown 不参与锁显（乙-⑥）", () => {
    expect(SRC).not.toMatch(/const locked = [^;\n]*linkDown/);
    expect(SRC).toMatch(/const locked = rcCapsuleLockOf\(/);
  });
});

/** 乙档把手外观档：优先级 隐形 > 染红 > 染橙 > 常态。 */
describe("rcHandleStateOf", () => {
  it("指针锁定 = 隐形（本地没有光标，常驻只会白吃像素）", () => {
    expect(rcHandleStateOf({ pointerLocked: true, linkDown: false, attention: false })).toBe(
      "dim",
    );
    // 锁指针时哪怕链路断了/有请求也隐形——点不着的东西不该亮着
    expect(rcHandleStateOf({ pointerLocked: true, linkDown: true, attention: true })).toBe("dim");
  });

  it("链路异常 = 染红，且盖过徽标（异常比待办更要紧）", () => {
    expect(rcHandleStateOf({ pointerLocked: false, linkDown: true, attention: false })).toBe("bad");
    expect(rcHandleStateOf({ pointerLocked: false, linkDown: true, attention: true })).toBe("bad");
  });

  it("有等你处理的 = 整枚染橙；三者皆无 = 常态", () => {
    expect(rcHandleStateOf({ pointerLocked: false, linkDown: false, attention: true })).toBe("ask");
    expect(rcHandleStateOf({ pointerLocked: false, linkDown: false, attention: false })).toBe(
      "idle",
    );
  });
});
