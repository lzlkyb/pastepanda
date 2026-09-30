/**
 * 丙-③「暂停对方观看」的纯判断 + 跨端接线守卫。
 *
 * 分两类钉：
 * 1. **措辞边界**：这条按钮改的是「对方能不能看见我」，安全语义。把它写成「已断开」
 *    会让人以为会话断了（其实对方的键鼠还在动这台机器），写成「黑屏」会让人以为
 *    屏幕上盖了东西（其实只是不再出帧）。两种误读都比没这个按钮更糟，所以把
 *    「不许出现某些词」直接写成断言。
 * 2. **接线**：状态字段名 `video_paused` / `peer_video_paused` 在 Rust 与前端各存
 *    一份，写错不报错——两端只会永远显示「没暂停」。范式照搬 `rcPrivPill.test.ts`。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  rcPauseBadgeOf,
  rcPauseButtonOf,
  rcPeerPausedOutletOf,
  rcPeerPausedPillOf,
} from "./rcVideoPause";

const GATE = readFileSync(resolve(__dirname, "../../src-tauri/src/rc/service/video_pause.rs"), "utf-8");
const TYPES = readFileSync(resolve(__dirname, "./api/rcTypes.ts"), "utf-8");

describe("rcPauseButtonOf（被控端抽屉那颗键）", () => {
  it("两态各一个词，且都不许说成「断开」或「黑屏」", () => {
    const off = rcPauseButtonOf(false);
    const on = rcPauseButtonOf(true);
    expect(off.label).toBe("暂停对方观看");
    expect(on.label).toBe("恢复对方观看");
    for (const t of [off.tip, on.tip, off.label, on.label]) {
      expect(t).not.toMatch(/已断开|连接断开|黑屏/);
    }
  });
  it("提示要说清「会话不断、键鼠照用」——否则被控者以为已经把对方赶出去了", () => {
    expect(rcPauseButtonOf(true).tip).toContain("会话没断");
    expect(rcPauseButtonOf(false).tip).toContain("暂时收回我的键鼠");
  });
});

describe("rcPauseBadgeOf / 胶囊行常驻徽标", () => {
  it("只在暂停成立时给文案（未暂停不凭空挂一枚读不懂的琥珀条）", () => {
    expect(rcPauseBadgeOf(false)).toBeNull();
    expect(rcPauseBadgeOf(true)).toContain("画面已暂停");
  });
});

describe("rcPeerPausedPillOf / 发起端告知", () => {
  it("旧对端不发这条帧 ⇒ null：没有证据就不摆断言", () => {
    expect(rcPeerPausedPillOf(undefined)).toBeNull();
    expect(rcPeerPausedPillOf(null)).toBeNull();
    expect(rcPeerPausedPillOf(false)).toBeNull();
    expect(rcPeerPausedPillOf(true)).toBe("对方已暂停画面");
  });
  it("出口条要说清「还在被操作」——只说画面会让人以为对方进不来", () => {
    const o = rcPeerPausedOutletOf(true)!;
    expect(o.label).toBe("对方暂停了画面");
    expect(o.detail).toContain("键鼠与剪贴板照常");
    expect(rcPeerPausedOutletOf(false)).toBeNull();
  });
});

describe("丙-③ 跨端接线", () => {
  it("投影字段名两边逐字相同（写错=两端都以为没暂停，且不报错）", () => {
    expect(GATE).toContain("pub(in crate::rc) fn video_paused(");
    expect(GATE).toContain("pub fn peer_video_paused(");
    expect(TYPES).toContain("video_paused?: boolean;");
    expect(TYPES).toContain("peer_video_paused?: boolean;");
  });
  it("控制帧名在 Rust 一侧只有一处写法（被控端出帧、发起端分派同词）", () => {
    expect(GATE).toContain('"t": "vpause"');
    const outbound = readFileSync(resolve(__dirname, "../../src-tauri/src/rc/outbound.rs"), "utf-8");
    expect(outbound).toContain('Some("vpause")');
  });
});
