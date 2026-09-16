/**
 * rcPairState.ts — 远程配对「完成配对」按钮可用性的纯函数判定。
 *
 * ❗ 抽成纯函数是为了让历史死锁回归可测：过去完成按钮依赖 `checked`，
 * 而 `checked` 又依赖 preview 出的指纹，指纹又只能靠能点的按钮去 preview ——
 * 三者互相卡死。防回归关键点：没有 `previewFp` 时即便 `checked` 为真也**必须**
 * 不可点，否则用户换台机器第一次配对会卡死在「勾选框永远不出现」。
 */
export interface PairSubmitState {
  code: string;
  checked: boolean;
  previewFp: string | null;
  busy: boolean;
}

/** 四要件齐备且不忙，按钮才可点；任一不满足即不可点。 */
export function canSubmitPair(s: PairSubmitState): boolean {
  return s.code.trim().length > 0 && s.checked && s.previewFp !== null && !s.busy;
}
