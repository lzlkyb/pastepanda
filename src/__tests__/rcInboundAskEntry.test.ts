/**
 * 入站申请入口收口守卫（2026-10-01 方案甲）。
 *
 * 背景：入站远程申请曾经有**三个** UI 入口——置顶浮层 `RcAskPop`（唯一决策现场）、
 * 主窗 `RcOverlay` 里的确认卡、远程电脑页 `RcWorkbenchOverlays` 里的同一张卡。
 * 弹框在场时三处同亮一个敲门 = 同一决策多处可点（AGENTS.md §15 反面教材），
 * 两张卡连同 pending 的 toast / 拉窗 effect 一并删除。
 *
 * 本文件钉住删除的**不变量**，防回潮：
 * ① 主窗与远程电脑页源码里不再出现申请卡组件 / approve / deny 调用；
 * ② `RcJoinRequests.tsx` / `RcWorkbenchOverlays.tsx` 两个文件保持不存在。
 *
 * 不变量被真正推翻时（例如重新设计出别的兜底），请改这里的断言并写明理由，
 * 而不是把断言删掉——「同一敲门只剩一处可点」就是这条守卫存在的意义。
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = process.cwd();
const overlay = readFileSync(resolve(root, "src/components/rc/RcOverlay.tsx"), "utf8");
const workbench = readFileSync(resolve(root, "src/components/rc/RcWorkbench.tsx"), "utf8");

describe("入站申请入口收口守卫（2026-10-01 方案甲）", () => {
  it("① 主窗 RcOverlay 不渲染申请卡，也不为 pending 起 toast / 拉窗", () => {
    expect(overlay).not.toContain("RcJoinRequests");
    // approve/deny 是入站申请的答复动作；配对敲门用的是 approveJoin/denyJoin，
    // 这条断言区分得开（join 后缀的名字不会被 `rc.approve(` 匹配到）。
    expect(overlay).not.toContain("rc.approve(");
    expect(overlay).not.toContain("rc.deny(");
  });

  it("② 远程电脑页不再挂申请卡片（配对层 RcPairLayer 是另一回事，保留）", () => {
    expect(workbench).not.toContain("RcJoinRequests");
    expect(workbench).not.toContain("RcWorkbenchOverlays");
    expect(workbench).toContain("RcPairLayer");
  });

  it("③ 两个已删组件文件保持不存在（防 git 回滚式复活）", () => {
    expect(existsSync(resolve(root, "src/components/rc/RcJoinRequests.tsx"))).toBe(false);
    expect(existsSync(resolve(root, "src/components/rc/RcWorkbenchOverlays.tsx"))).toBe(false);
  });
});
