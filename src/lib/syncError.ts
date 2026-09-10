/**
 * 把知识库同步的错误串翻成人话——或者判定它**根本不该出现在界面上**。
 *
 * # 为什么需要它
 *
 * 后端的错误串是「中文前缀 + 底层库原文」拼出来的，例如
 * `sync/transport.rs` 里的 `format!("连接对端失败：{}", e)`，得到的是
 * **「连接对端失败：timed out」**。中文那半截是我们写的、说明断在哪一步；
 * 英文那半截是 iroh / quinn 的 `Display`，对用户是天书。
 * 而 `KbSyncStatusBar` 一直把整串原样打在屏幕上（2026-09-10 用户报「看不懂」）。
 *
 * # 🔴 但主要问题不是「没翻译」，是「不该显示」
 *
 * 那条提示的上一句已经写着「对方可能刚关机、换了网络，或关了这个开关」——
 * 那正是 `timed out` 在这个场景下的**全部含义**。后面再跟一串英文，
 * 不但没增加信息，还让人以为出了需要处理的技术故障。
 *
 * 所以本模块的判据与 `KbSyncStatusBar` 自己的分级原则一致：
 * **「你能不能处理」**。处理不了的一律返回 `null`（什么都不显示），
 * 能处理的才给一句说得清的话。
 *
 * # 后端一个字不改
 *
 * 原始错误串还要留给日志排错（`[Sync] 与 X 同步失败（连续第 N 次）…：{}`），
 * 也还要给 `is_busy_reject` / `is_not_paired_reject` 做退避决策。
 * 翻译是**展示层**的事，在这里做。
 */

/**
 * 「对方在忙 / 正在让位」——正常协作，不是故障。
 *
 * 🔴 这四个字样与后端 `sync/service.rs` 的 `is_busy_reject` **逐条对应**，
 * 而那边的字样又来自 `coordinate::Coordinator::admit` 与
 * `join::REJECT_PENDING`。跨了 Rust / TS 没法共享常量，
 * **改一处要改两处**。
 */
const BUSY = ["正在向你发起同步", "让位", "稍后重试", "等待对方确认"];

/**
 * 「就是没连上」。这一类**不显示**：调用点的上一句已经把原因说完了。
 *
 * ❗ 全部小写比对：这些字样来自 iroh / quinn / std 的 `Display`，
 *   跟着上游升级可能变大小写，宁可宽一点。
 */
const JUST_OFFLINE = [
  "timed out",
  "timeout",
  "connection lost",
  "connection refused",
  "no addresses",
  "unreachable",
  "closed by peer",
];

/**
 * 错误串 → 界面上该显示的一句话。`null` = **什么都不显示**。
 *
 * ❗ 返回 `null` 不意味着「没错」，只意味着「这条对用户没用」。
 *   调用方仍然应该把**原串**放进 `title`，排错时悬停就能看到。
 */
export function explainSyncError(raw: string | null | undefined): string | null {
  if (!raw) return null;
  const lower = raw.toLowerCase();

  // 对方在忙 / 让位：下一轮自己就好了，报出来只会让人以为坏了。
  if (BUSY.some((k) => raw.includes(k))) return null;

  /**
   * 🔴 必须排在 `JUST_OFFLINE` **之前**。
   *
   * `session::explain` 会把关闭原因拼成 `{err}（{reason}）`，于是真实串长成
   * 「读帧长度失败：connection lost（not paired）」——里面同时含有
   * `connection lost`。顺序反了的话，这条**用户真能处理**的错误
   * 会被当成「对方没开机」静默掉。
   */
  if (lower.includes("not paired")) {
    return "对方那台机器上没有本设备——到它的「知识库同步」里重新配对一次。";
  }

  // 就是没连上：调用点的上一句已经写了「对方可能刚关机、换了网络…」。
  if (JUST_OFFLINE.some((k) => lower.includes(k))) return null;

  /**
   * 🔴 整串没有英文字母 ⇒ 后端已经写成人话了，**原样给出、一个字不切**。
   *
   * `sync/service.rs` 里真有这种：
   *   「对方还没把这台设备加回去——到那台机器的「知识库同步」里确认连接请求（要核对指纹）」
   * 它们恰好没带全角冒号，所以下面那个 `split` 目前不会截到——但那是**运气**。
   * 只要以后有人在这类文案里写一个「：」，后半句就默默没了。
   *
   * 切前缀的目的本来就只是「把底层库的英文原文去掉」；压根没英文，就没什么可切的。
   */
  if (!/[a-z]/i.test(raw)) return raw.trim() || null;

  /**
   * 剩下的当真故障报，但只留**中文前缀**（“读帧长度失败”），英文原文交给 `title`。
   *
   * ❗ 分隔符用 `：` 或「半角冒号 + 空白」，**不能光用半角 `:`**：
   *   `transport.rs` 有 `format!("写文件失败 {}：{}", path.display(), e)`，
   *   而 Windows 路径里就带着 `D:`——光切半角冒号会得到“写文件失败 D”。
   *   （`attach.rs` / `engine.rs` 那几条用的是半角 `: `，所以两种都得认。）
   */
  const zh = raw.split(/：|:\s/)[0].trim();
  return zh || null;
}
