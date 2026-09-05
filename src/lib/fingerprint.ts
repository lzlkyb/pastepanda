/**
 * 同步身份的短指纹（给人肉眼核对用）。
 *
 * ❗ 原本写在 `KbPairDialog.tsx` 里。拆到 lib 是因为配对向导拆成了多个组件文件，
 * 都要用它；留在其中任一个组件里就会出现循环引用（规则 #11：公共函数收口）。
 */

/**
 * 从 `node_id`（64 字符 hex）取前 4 组做短指纹，与后端
 * `NodeIdentity::fingerprint()` 必须一致：前 16 个字符按 4 分组。
 *
 * ❗ 前后端各算一遍是有意的：邀请码里只有 `node_id`，**没有指纹字段**
 * （少一个可自称的字段）。所以这里的分组规则改动时，
 * `src-tauri/src/sync/identity.rs` 里那个也要一起改。
 */
export function fingerprintOf(nodeId: string): string {
  return (nodeId.match(/.{1,4}/g) ?? []).slice(0, 4).join("-");
}
