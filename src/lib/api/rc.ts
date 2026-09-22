/**
 * 远程电脑 API（方案 A：与同步配对分离）——对应 `src-tauri/src/commands/rc.rs`。
 *
 * 本文件现为**门面（facade）**：实现已按域拆到 `rcTypes` / `rcFrameTypes` /
 * `rcFrameParse` / `rcCommands` 四个子模块，这里只做 re-export，保证所有
 * `from "@/lib/api/rc"` 的引用继续原样工作。拆分只搬代码、不改行为。
 *
 * 字段名与 Rust 一致（snake_case）。失败由调用方 toast，这里不吞。
 *
 * ❗ A3 的局域网 6 位数字配对**不在本文件**：见 `lib/api/rcPair.ts`。
 *    那是独立的一条路（对应 `commands/rc_pair.rs`），与这里的邀请码 / 会话
 *    命令没有共用状态，拆开是为了让两边都别逼近 `.ts ≤ 400` 的红线。
 */
export * from "./rcTypes";
export * from "./rcFrameTypes";
export * from "./rcFrameParse";
export * from "./rcCommands";
