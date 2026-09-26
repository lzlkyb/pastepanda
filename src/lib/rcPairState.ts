/**
 * rcPairState.ts — 远程配对「发送配对请求」按钮可用性的纯函数判定。
 *
 * ❗ 抽成纯函数是为了让历史死锁回归可测：过去完成按钮依赖 `checked`，
 * 而 `checked` 依赖 preview 出的指纹，指纹又只能靠「能点的按钮」去 preview ——
 * 三者互相卡死。
 *
 * 🔴 **2026-09-17（方案 C）：`checked` 这一项被删掉了。** 两条理由：
 *
 * ① **那次核对本来就防不住中间人**。邀请码是**自签**的：攻击者把整串码换成
 *    自己的那一份，两端显示的都是**攻击者的**指纹，用户认真比对了也会一致
 *    （完整论证见 `src-tauri/src/sync/invite.rs` 模块头）。
 * ② **真正把关的是生成方那一侧的确认**（`RcJoinRequests` 的卡片）——
 *    那次确认发生在**写入白名单的那一侧**，是唯一有后果的一次。
 *
 * 顺带的效果：死锁**在结构上不可能回来**了。按钮不再依赖任何「要等别的 UI
 * 先渲染出来」的状态，剩下的三项都是当场就能知道的量。
 */
export interface PairSubmitState {
  code: string;
  /** 已解析出的对方指纹；`null` = 还没解析出来（按钮此时必须不可点）。 */
  previewFp: string | null;
  busy: boolean;
}

/** 三要件齐备且不忙，按钮才可点；任一不满足即不可点。 */
export function canSubmitPair(s: PairSubmitState): boolean {
  return s.code.trim().length > 0 && s.previewFp !== null && !s.busy;
}

/**
 * 剪贴板内容的**粗筛**：长得像一份配对码才去调后端解析。
 *
 * 乙方案（2026-09-26）后唯一的调用点在 `RcPairPastePane`——进到粘贴屏才问，
 * 不再一开向导就拦。它只是省一次 IPC 的启发式，真判据仍是 `rc_preview_invite`。
 */
export function looksLikeRcInvite(t: string): boolean {
  const s = t.trim();
  return s.length >= 40 && /^[A-Za-z0-9_-]+$/.test(s);
}
