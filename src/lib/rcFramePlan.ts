/**
 * 帧批应用计划 —— 决定一次 drain 到的一批帧**从哪一帧开始画**（丢掉前面积压的过期帧）。
 *
 * 为什么需要：后端 outbox 是「生产 → 前端消费」的有界队列（`FrameOutbox::CAP`
 * 90 帧）。消费一旦落后，队列里积压的每一帧都在**线性放大端到端延迟**——表现就是
 * 「操作完画面 1~3 秒才变」。HUD 上那段「网络 1238ms」其实就是它：net =
 * 画面龄 − 采集 − 编码 − 解码，是个**余数**，里面积压的排队占大头，不是链路慢。
 *
 * 丢帧的安全边界（这一条决定能不能丢、能丢多少）：
 * - **JPEG 整帧**（`full` 为真，或没有 rect）自成一体：画上去覆盖整张画布
 *   ⇒ 它之前的帧**全部**可以安全丢弃，只画最新那一张。
 * - **JPEG 脏块帧**只覆盖一小块，依赖前一张画布的内容 ⇒ 不能单独丢；
 *   但整帧会把画布重画一遍，所以「整帧 + 其后脏块帧」是自洽序列。
 * - **H.264 / HEVC** 的 P 帧引用前一帧，丢一帧即花屏 ⇒ 批里只要有**任何**
 *   非 JPEG 帧，本批整批不跳，交回原有的全序逐帧应用 + `corrupt` 断链保护。
 *
 * 返回起始下标：0 = 不跳（全部按序应用）；>0 = 从该帧开始应用。
 */
import type { RcBinFrame } from "./api/rcFrameTypes";

export function frameApplyStart(frames: readonly RcBinFrame[]): number {
  // 有非 JPEG 帧（H.264 / HEVC）⇒ 整批全序，一帧都不能丢
  if (frames.some((f) => f.codec !== "jpeg")) return 0;
  // 从后往前找最后一个整帧；`full` 与「无 rect」是同一件事的两种表达，
  // 与 RcScreenCanvas / useRcFrames 里画整帧的判据保持一致。
  for (let i = frames.length - 1; i > 0; i--) {
    const f = frames[i];
    if (f.full || !f.rect) return i;
  }
  return 0;
}
