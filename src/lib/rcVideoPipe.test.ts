/**
 * 丙（2026-10-12，Issue #19）「对方编码档位回传发起端」的纯判断 + 跨端接线守卫。
 *
 * 现场教训：局域网直连 RTT 35ms，画面却是幻灯片。原因在被控端进程里（硬编连败 →
 * 软编 → 仍失败 → 熔断成 JPEG 全帧），而它当时**只写被控端日志**。发起端只看得到
 * 症状，于是「是不是你的网不好」这种猜话就成了唯一解释。这条测试钉两件事：
 * 1. **措辞边界**：摆出来的每一档都必须将故障归到对方机器，不许说成链路/网络问题，
 *    也不许说成「对方离线」「连接断开」（会话、键鼠、剪贴板都还通着）。
 * 2. **接线与档名表**：线上跑的是 ASCII 档名（`hw`/`sw`/`enc_fuse`/`grab_fuse`/
 *    `single`/`no_enc`/`jpeg`），中文标签只当诊断原文。让前端 substring 匹配中文
 *    ＝对方改一个字这里静默错判，而那正是最贵的一种误判。范式照搬 `rcVideoPause.test.ts`。
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { rcPeerPipeOutletOf, rcPeerPipePillOf } from "./rcVideoPipe";

const SRC = (rel: string) => readFileSync(resolve(__dirname, "../../src-tauri/src/rc/", rel), "utf-8");
const GATE = SRC("service/video_pipe.rs");
const TYPES = readFileSync(resolve(__dirname, "./api/rcTypes.ts"), "utf-8");

describe("rcPeerPipePillOf（发起端胶囊那枚短标签）", () => {
  it("旧对端不发这条帧 ⇒ null：没有证据就不摆断言", () => {
    expect(rcPeerPipePillOf(undefined)).toBeNull();
    expect(rcPeerPipePillOf(null)).toBeNull();
    expect(rcPeerPipePillOf("")).toBeNull();
  });
  it("未知档名 ⇒ null（前端不许对没见过的档编造解释）", () => {
    expect(rcPeerPipePillOf("wat")).toBeNull();
  });
  it("正常态与瞬态不摆：hw / single / jpeg（非 Windows 的常态）/ no_enc（分不清）", () => {
    for (const code of ["hw", "single", "jpeg", "no_enc"]) {
      expect(rcPeerPipePillOf(code)).toBeNull();
    }
  });
  it("三档降级各有文案，且都指到「对方」而不是你的网络", () => {
    for (const code of ["sw", "enc_fuse", "grab_fuse"]) {
      const pill = rcPeerPipePillOf(code)!;
      expect(pill.label).toMatch(/^对方/);
      expect(pill.detail).toContain("不是你的网络");
      // 会话没断：不许把设备故障写成连接问题（与 vpause 同一条纪律）。
      expect(pill.detail).not.toMatch(/连接断开|已断开|对方离线|网络异常|网络不好/);
    }
  });
  it("色档分两级：只剩软编还能跑（warn），退到 JPEG 才是 bad", () => {
    expect(rcPeerPipePillOf("sw")!.tone).toBe("warn");
    expect(rcPeerPipePillOf("enc_fuse")!.tone).toBe("bad");
    expect(rcPeerPipePillOf("grab_fuse")!.tone).toBe("bad");
  });
});

describe("rcPeerPipeOutletOf（胶囊收起时的常驻落点）", () => {
  it("与 pill 同判据：该摆的档两边都摆，不该摆的两边都空", () => {
    for (const code of ["", "hw", "jpeg", "enc_fuse", "grab_fuse", "sw"]) {
      const pill = rcPeerPipePillOf(code);
      const outlet = rcPeerPipeOutletOf(code);
      expect(outlet === null).toBe(pill === null);
      if (pill && outlet) {
        expect(outlet.label).toBe(pill.label);
        expect(outlet.tone).toBe(pill.tone);
      }
    }
  });
});

describe("丙 跨端接线", () => {
  it("投影字段名两边逐字相同（写错=两端都以为没收到，且不报错）", () => {
    expect(GATE).toContain("pub(in crate::rc) fn peer_video_pipe(");
    expect(TYPES).toContain("peer_video_pipe?: string;");
    expect(TYPES).toContain("peer_video_pipe_label?: string;");
  });
  it("控制帧名在 Rust 一侧只有一处写法（被控端出帧、发起端分派同词）", () => {
    expect(GATE).toContain('"t": "vpipe"');
    expect(SRC("outbound.rs")).toContain('Some("vpipe")');
  });
  it("出帧端在 5s 汇总那一拍推、只在变档时推", () => {
    expect(SRC("inbound/video_run.rs")).toContain("self.emit_pipe_if_changed().await");
    expect(SRC("inbound/video.rs")).toContain("if self.last_pipe_code == Some(code)");
  });
  it("发起端两个落点都接上了（浮条胶囊 + 常驻出口条），不是只挂一处", () => {
    const alerts = readFileSync(resolve(__dirname, "../components/rc/RcCapsuleAlerts.tsx"), "utf-8");
    const outlet = readFileSync(resolve(__dirname, "../components/rc/RcCapsuleOutlet.tsx"), "utf-8");
    const host = readFileSync(resolve(__dirname, "../components/rc/RcCapsuleIdentity.tsx"), "utf-8");
    const capsule = readFileSync(resolve(__dirname, "../components/rc/RcSessionCapsule.tsx"), "utf-8");
    expect(alerts).toContain("rcPeerPipePillOf(peerVideoPipe)");
    expect(outlet).toContain("rcPeerPipeOutletOf(peerVideoPipe)");
    // 中间层漏传 = 两端都永远不摆，且不报错（规则 15.1 的同域断在这一步）。
    expect(host).toContain("peerVideoPipe={peerVideoPipe}");
    expect(capsule.match(/peerVideoPipe=\{rc\.status\?\.peer_video_pipe\}/g)?.length).toBe(2);
  });
  it("「操作后 Ns 无画面」被 bad 档压掉——把设备故障说成链路警示会把人引去点重连", () => {
    const alerts = readFileSync(resolve(__dirname, "../components/rc/RcCapsuleAlerts.tsx"), "utf-8");
    expect(alerts).toContain("!pausedPill && !pipeBad");
  });
});
