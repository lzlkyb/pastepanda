/**
 * rcVideoPipe — 「对方那台机器的编码管线现在是什么档」的措辞与判据唯一真源（规则 11.1）。
 *
 * # 这条存在的原因（Issue #19，2026-10-12）
 * 现场是：局域网直连、RTT 35ms，画面却像幻灯片。原因在被控端进程里（硬编连败 →
 * 换软编 → 仍失败 → 熔断成 JPEG 全帧），而它当时**只写被控端日志**。发起端只看得到
 * 症状，于是每一条解释都是猜。规则 15.1：症状常驻可见，原因也必须常驻可见——
 * 所以它落在与「对方已暂停画面」「主机取回键鼠」同一排胶囊上。
 *
 * # 为什么读档名而不是读中文
 * 线上跑的是稳定枚举（`hw` / `sw` / `enc_fuse` / `grab_fuse` / `single` / `no_enc` / `jpeg`），
 * 中文标签只作为诊断原文附带（`status.peer_video_pipe_label`）。让前端 substring 匹配
 * 中文＝对方改一个字这里就静默错判，而那正是「把对方机器的故障说成你的网络不行」
 * 这种误判最贵的地方。档名表真源在 `src-tauri/src/rc/service/video_pipe.rs`，
 * 两端各有一条守卫测试钉住（`rcVideoPipe.test.ts` 跨端接线那组）。
 *
 * # 哪些档**不**摆
 * - `hw` / `single`：正常态 / 瞬态（一帧没编出来），摆出来就是噪声；
 * - `no_enc`：它是「用户把画质配成 JPEG」和「编码器打不开」的并集，分不清 ⇒
 *   没有证据不摆断言（与「对方已静音」同一条纪律）；
 * - `jpeg`：非 Windows 宿主恒 JPEG，那是它的正常态，不是降级；
 * - 空串 / 缺失：旧对端不发这条帧 ⇒ 什么都不摆。
 */

export type RcPeerPipeTone = "warn" | "bad";

export type RcPeerPipePill = {
  /** 胶囊短标签（宽度是硬约束，只放结论）。 */
  label: string;
  tone: RcPeerPipeTone;
  /** 完整说明：挂在 title（胶囊）与出口条详情行上。 */
  detail: string;
};

const PIPE_TABLE: Record<string, RcPeerPipePill> = {
  sw: {
    label: "对方软件编码",
    tone: "warn",
    detail:
      "对方的硬件编码器连续失败，已改用 CPU 软件编码（仍是 H.264）。帧率会比硬件编码低，这不是你的网络问题；他那边冷却期后会自行重试硬件编码。",
  },
  enc_fuse: {
    label: "对方编码降级",
    tone: "bad",
    detail:
      "对方的硬件与软件编码都连续失败，画面已退到逐帧 JPEG（看起来像幻灯片）。故障在他那台机器的编码器/驱动，不是你的网络；他那边会带冷却自动重试恢复。",
  },
  grab_fuse: {
    label: "对方抓屏降级",
    tone: "bad",
    detail:
      "对方抓取屏幕的通道（桌面复制）已熔断，只能按帧走备用抓取，帧率会明显下降。通常与他的显卡驱动或全屏保护内容有关，不是你的网络。",
  },
};

/** 发起端胶囊上那枚短标签（`null` = 不摆）。 */
export function rcPeerPipePillOf(
  code: string | null | undefined
): RcPeerPipePill | null {
  if (!code) return null;
  return PIPE_TABLE[code] ?? null;
}

/**
 * 浮条收起时的常驻落点（规则 15.1：胶囊会随 `.capFloat` 隐形，常驻事实要有常驻出口）。
 * 与 `rcPeerPausedOutletOf` 同形状，措辞比胶囊多一句「在你这边能看到什么」。
 */
export function rcPeerPipeOutletOf(
  code: string | null | undefined
): { label: string; detail: string; tone: RcPeerPipeTone } | null {
  const pill = rcPeerPipePillOf(code);
  if (!pill) return null;
  return { label: pill.label, detail: pill.detail, tone: pill.tone };
}
