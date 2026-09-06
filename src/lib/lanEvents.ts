/**
 * lanEvents.ts —— 局域网同步的后端事件名。
 *
 * ❗ 单独抽一个文件而不是就地写字符串，是因为这类常量的漂移**没有任何报错**：
 * Rust 那边 `emit` 一个名字、前端 `listen` 另一个，结果就是「配对完了列表不刷新」
 * ——而那正是 2026-09-06 要修的那个 bug 本身。
 * `lanEvents.test.ts` 会直接读 Rust 源码比对，改单边会红。
 */

/**
 * 「记住的设备」名单变了。
 *
 * 与 `lan_sync.rs` 的 `EVENT_PAIRED_CHANGED` 必须逐字相同。
 */
export const LAN_PAIRED_CHANGED = "lan-paired-changed";
